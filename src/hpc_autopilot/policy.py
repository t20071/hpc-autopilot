"""Scheduling policy: fair-share priority, per-role limits and EASY backfill.

These are pure functions with no database access, so they are easy to test.
They follow the ideas of Slurm's priority/multifactor plugin and backfill scheduler.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from .config import QosSpec, Settings


@dataclass
class NodeState:
    name: str
    partition: str
    cpus: int
    memory_gb: int
    gpus: int
    available: bool = True
    used_cpus: int = 0
    used_memory_gb: int = 0
    used_gpus: int = 0

    @property
    def free_cpus(self) -> int:
        return self.cpus - self.used_cpus

    @property
    def free_memory_gb(self) -> int:
        return self.memory_gb - self.used_memory_gb

    @property
    def free_gpus(self) -> int:
        return self.gpus - self.used_gpus

    def can_ever_fit(self, job: PendingJob) -> bool:
        return (
            self.partition == job.partition
            and self.cpus >= job.cpus
            and self.memory_gb >= job.memory_gb
            and self.gpus >= job.gpus
        )

    def fits_now(self, job: PendingJob) -> bool:
        return (
            self.available
            and self.can_ever_fit(job)
            and self.free_cpus >= job.cpus
            and self.free_memory_gb >= job.memory_gb
            and self.free_gpus >= job.gpus
        )

    def allocate(self, job: PendingJob | RunningJob) -> None:
        self.used_cpus += job.cpus
        self.used_memory_gb += job.memory_gb
        self.used_gpus += job.gpus


@dataclass
class PendingJob:
    id: int
    user: str
    role: str
    account: str
    partition: str
    cpus: int
    memory_gb: int
    gpus: int
    time_limit_s: float
    submit_time: float
    priority: float = 0.0


@dataclass
class RunningJob:
    id: int
    user: str
    account: str
    node: str
    cpus: int
    memory_gb: int
    gpus: int
    start_time: float
    time_limit_s: float

    @property
    def expected_end(self) -> float:
        return self.start_time + self.time_limit_s


@dataclass
class Plan:
    starts: list[tuple[int, str]] = field(default_factory=list)
    reasons: dict[int, str] = field(default_factory=dict)
    backfilled: set[int] = field(default_factory=set)
    priorities: dict[int, float] = field(default_factory=dict)


def decayed_usage(rows: Iterable[Mapping], now: float, settings: Settings) -> dict[str, float]:
    """Billing-seconds used per account, with older usage decaying by a half-life."""
    halflife_s = max(settings.usage_halflife_hours, 0.001) * 3600
    usage: dict[str, float] = {}
    for r in rows:
        if r["start_time"] is None:
            continue
        end = r["end_time"] or now
        duration = max(0.0, end - r["start_time"])
        billing = duration * (r["cpus"] + r["gpus"] * settings.gpu_billing_weight)
        decay = 0.5 ** (max(0.0, now - end) / halflife_s)
        usage[r["account"]] = usage.get(r["account"], 0.0) + billing * decay
    return usage


def fairshare_factor(account: str, usage: Mapping[str, float], shares: Mapping[str, int]) -> float:
    """Slurm's classic fair-share factor: 2 ** (-normalised usage / normalised share).

    1.0 means the account has used nothing; 0.5 means it has used exactly its share.
    """
    total_shares = sum(shares.values())
    share = shares.get(account, 0) / total_shares if total_shares else 0.0
    if share <= 0:
        return 0.0
    total_usage = sum(usage.values())
    if total_usage <= 0:
        return 1.0
    return 2.0 ** (-(usage.get(account, 0.0) / total_usage) / share)


def job_priority(job: PendingJob, now: float, fairshare: float, qos: QosSpec, settings: Settings) -> float:
    waited_min = max(0.0, now - job.submit_time) / 60
    saturation = settings.age_saturation_minutes
    age_factor = min(1.0, waited_min / saturation) if saturation > 0 else 1.0
    qos_factor = min(1.0, max(0.0, qos.priority / 100))
    return round(
        settings.weight_fairshare * fairshare
        + settings.weight_age * age_factor
        + settings.weight_qos * qos_factor,
        1,
    )


def limit_reason(job: PendingJob, user_running: list[RunningJob], qos: QosSpec) -> str | None:
    """The Slurm-style reason a job must wait because of its role's limits, if any."""
    if len(user_running) >= qos.max_running_jobs:
        return "QOSMaxJobsPerUser"
    if sum(r.gpus for r in user_running) + job.gpus > qos.max_gpus_per_user:
        return "QOSMaxGPUPerUser"
    return None


def pick_node(job: PendingJob, nodes: list[NodeState]) -> NodeState | None:
    """Best fit: keep big free blocks for big jobs; keep GPU nodes free of CPU-only jobs."""
    candidates = [n for n in nodes if n.fits_now(job)]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda n: (
            job.gpus == 0 and n.gpus > 0,
            n.free_gpus - job.gpus,
            n.free_cpus - job.cpus,
            n.name,
        ),
    )


def earliest_start(job: PendingJob, nodes: list[NodeState], running: list[RunningJob], now: float) -> float:
    """When the job could start if running jobs end at their time limits (math.inf if never)."""
    best = math.inf
    for node in nodes:
        if not node.available or not node.can_ever_fit(job):
            continue
        free_cpus, free_mem, free_gpus = node.free_cpus, node.free_memory_gb, node.free_gpus
        if free_cpus >= job.cpus and free_mem >= job.memory_gb and free_gpus >= job.gpus:
            return now
        for r in sorted((r for r in running if r.node == node.name), key=lambda r: r.expected_end):
            free_cpus += r.cpus
            free_mem += r.memory_gb
            free_gpus += r.gpus
            if free_cpus >= job.cpus and free_mem >= job.memory_gb and free_gpus >= job.gpus:
                best = min(best, max(now, r.expected_end))
                break
    return best


def plan_schedule(
    pending: list[PendingJob],
    nodes: list[NodeState],
    running: list[RunningJob],
    now: float,
    settings: Settings,
    usage: Mapping[str, float],
) -> Plan:
    """Decide which pending jobs start now, and why the others wait.

    Jobs are taken in priority order. The highest-priority job that cannot start gets a
    reservation (the "shadow time"); lower-priority jobs may still start on idle resources
    if they will finish before that time (EASY backfill).
    """
    plan = Plan()
    for job in pending:
        qos = settings.qos[job.role]
        fairshare = fairshare_factor(job.account, usage, settings.account_shares)
        job.priority = job_priority(job, now, fairshare, qos, settings)
        plan.priorities[job.id] = job.priority

    running = list(running)
    shadow_time: float | None = None

    for job in sorted(pending, key=lambda j: (-j.priority, j.submit_time, j.id)):
        if not any(n.available and n.can_ever_fit(job) for n in nodes):
            plan.reasons[job.id] = "ReqNodeNotAvail"
            continue

        reason = limit_reason(job, [r for r in running if r.user == job.user], settings.qos[job.role])
        if reason:
            plan.reasons[job.id] = reason
            continue

        node = pick_node(job, nodes)
        if node is not None:
            if shadow_time is None:
                plan.reasons[job.id] = "Started"
            elif settings.backfill and now + job.time_limit_s <= shadow_time:
                plan.reasons[job.id] = "Backfilled"
                plan.backfilled.add(job.id)
            else:
                plan.reasons[job.id] = "Priority"
                continue
            node.allocate(job)
            running.append(
                RunningJob(job.id, job.user, job.account, node.name, job.cpus, job.memory_gb, job.gpus, now, job.time_limit_s)
            )
            plan.starts.append((job.id, node.name))
            continue

        if shadow_time is None:
            shadow_time = earliest_start(job, nodes, running, now)
            plan.reasons[job.id] = "Resources"
        else:
            plan.reasons[job.id] = "Priority"

    return plan
