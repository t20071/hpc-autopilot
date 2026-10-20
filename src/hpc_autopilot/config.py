"""Cluster settings, loaded from cluster.toml in the project home folder."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


def default_home() -> Path:
    env = os.environ.get("HPC_AUTOPILOT_HOME")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class NodeSpec:
    name: str
    partition: str
    cpus: int
    memory_gb: int
    gpus: int
    gpu_type: str


@dataclass(frozen=True)
class QosSpec:
    name: str
    priority: int
    max_gpus_per_user: int
    max_running_jobs: int
    max_time_minutes: float


@dataclass(frozen=True)
class Settings:
    home: Path
    tick_seconds: float
    backfill: bool
    weight_fairshare: float
    weight_age: float
    weight_qos: float
    age_saturation_minutes: float
    usage_halflife_hours: float
    gpu_billing_weight: float
    nodes: tuple[NodeSpec, ...]
    qos: dict[str, QosSpec]
    account_shares: dict[str, int]
    email_mode: str
    email_from: str
    admin_email: str
    smtp_host: str
    smtp_port: int
    smtp_starttls: bool
    smtp_user: str
    gpu_temp_limit_c: float
    auto_resume: bool
    backup_every_minutes: float
    backup_keep: int
    report_every_minutes: float
    purge_after_days: float
    allow_custom_commands: bool
    require_known_users: bool = False
    # username -> (role, account); when a user is listed, submissions must use that role and account
    users: dict[str, tuple[str, str]] = field(default_factory=dict)

    @property
    def db_path(self) -> Path:
        return self.home / "data" / "hpc.db"

    @property
    def outbox_dir(self) -> Path:
        return self.home / "outbox"

    @property
    def runs_dir(self) -> Path:
        return self.home / "runs"

    @property
    def backups_dir(self) -> Path:
        return self.home / "backups"

    @property
    def reports_dir(self) -> Path:
        return self.home / "reports"

    @property
    def jobs_dir(self) -> Path:
        return self.home / "jobs"

    @property
    def partitions(self) -> list[str]:
        return sorted({n.partition for n in self.nodes})


def load_settings(home: Path | str | None = None) -> Settings:
    home = Path(home).resolve() if home else default_home()
    with open(home / "cluster.toml", "rb") as f:
        raw = tomllib.load(f)

    sched = raw.get("scheduler", {})
    email = raw.get("email", {})
    health = raw.get("health", {})
    maint = raw.get("maintenance", {})
    security = raw.get("security", {})

    nodes = tuple(
        NodeSpec(
            name=n["name"],
            partition=n.get("partition", "gpu"),
            cpus=int(n["cpus"]),
            memory_gb=int(n["memory_gb"]),
            gpus=int(n.get("gpus", 0)),
            gpu_type=n.get("gpu_type", ""),
        )
        for n in raw.get("nodes", [])
    )
    if not nodes:
        raise ValueError("cluster.toml defines no [[nodes]]")

    qos = {
        name: QosSpec(
            name=name,
            priority=int(q.get("priority", 0)),
            max_gpus_per_user=int(q.get("max_gpus_per_user", 1)),
            max_running_jobs=int(q.get("max_running_jobs", 1)),
            max_time_minutes=float(q.get("max_time_minutes", 60)),
        )
        for name, q in raw.get("qos", {}).items()
    }
    if not qos:
        raise ValueError("cluster.toml defines no [qos.<role>] sections")

    return Settings(
        home=home,
        tick_seconds=float(sched.get("tick_seconds", 2)),
        backfill=bool(sched.get("backfill", True)),
        weight_fairshare=float(sched.get("weight_fairshare", 10000)),
        weight_age=float(sched.get("weight_age", 1000)),
        weight_qos=float(sched.get("weight_qos", 2000)),
        age_saturation_minutes=float(sched.get("age_saturation_minutes", 10)),
        usage_halflife_hours=float(sched.get("usage_halflife_hours", 24)),
        gpu_billing_weight=float(sched.get("gpu_billing_weight", 16)),
        nodes=nodes,
        qos=qos,
        account_shares={k: int(v) for k, v in raw.get("accounts", {"default": 1}).items()},
        email_mode=email.get("mode", "outbox"),
        email_from=email.get("from", "hpc-autopilot@localhost"),
        admin_email=email.get("admin", "hpc-admin@localhost"),
        smtp_host=email.get("smtp_host", "localhost"),
        smtp_port=int(email.get("smtp_port", 587)),
        smtp_starttls=bool(email.get("smtp_starttls", True)),
        smtp_user=email.get("smtp_user", ""),
        gpu_temp_limit_c=float(health.get("gpu_temp_limit_c", 85)),
        auto_resume=bool(health.get("auto_resume", True)),
        backup_every_minutes=float(maint.get("backup_every_minutes", 60)),
        backup_keep=int(maint.get("backup_keep", 10)),
        report_every_minutes=float(maint.get("report_every_minutes", 60)),
        purge_after_days=float(maint.get("purge_outputs_after_days", 7)),
        allow_custom_commands=bool(security.get("allow_custom_commands", False)),
        require_known_users=bool(security.get("require_known_users", False)),
        users={name: (u["role"], u["account"]) for name, u in raw.get("users", {}).items()},
    )
