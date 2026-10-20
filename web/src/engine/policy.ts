// Pure scheduling policy: multifactor priority, per-role limits, best-fit placement and EASY backfill.
import type { Cluster, Job, Node, PriorityFactors, Settings } from "./types";

export const billing = (job: Pick<Job, "cpus" | "gpus">, s: Settings) => job.cpus + job.gpus * s.gpuBillingWeight;

/** Billing-weighted core-seconds per account, halved every `halflifeH` hours. */
export function decayedUsage(jobs: Job[], now: number, s: Settings): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const j of jobs) {
    if (j.startTime === undefined) continue;
    const end = j.endTime ?? now;
    const elapsed = Math.max(0, end - j.startTime);
    const ageH = Math.max(0, now - end) / 3600;
    usage[j.account] = (usage[j.account] ?? 0) + billing(j, s) * elapsed * 2 ** (-ageH / s.halflifeH);
  }
  return usage;
}

/** Slurm's classic fair-share factor 2^(-U/S): 1 = unused, 0.5 = used exactly its share. */
export function fairshareFactor(account: string, usage: Record<string, number>, shares: Record<string, number>): number {
  const totalUsage = Object.values(usage).reduce((a, b) => a + b, 0);
  const totalShares = Object.values(shares).reduce((a, b) => a + b, 0) || 1;
  const S = (shares[account] ?? 1) / totalShares;
  const U = totalUsage > 0 ? (usage[account] ?? 0) / totalUsage : 0;
  return 2 ** (-U / S);
}

export function priorityFactors(job: Job, now: number, fairshare: number, s: Settings): PriorityFactors {
  const age = Math.min(1, Math.max(0, now - (job.eligibleTime ?? job.submitTime)) / 60 / s.ageSaturationMin);
  const f = {
    fairshare: s.weights.fairshare * fairshare,
    age: s.weights.age * age,
    qos: s.weights.qos * (s.qos[job.role].priority / 100),
  };
  return { ...f, total: f.fairshare + f.age + f.qos };
}

interface Free {
  node: Node;
  cpus: number;
  memGb: number;
  gpuIds: number[];
}

interface Running {
  node: string;
  user: string;
  cpus: number;
  memGb: number;
  gpus: number;
  gpuIds: number[];
  expectedEnd: number;
}

const fitsTotal = (j: Job, n: Node) => j.cpus <= n.cpus && j.memGb <= n.memGb && j.gpus <= n.gpus;
const fitsFree = (j: Job, f: Free) => j.cpus <= f.cpus && j.memGb <= f.memGb && j.gpus <= f.gpuIds.length;

export function freeResources(c: Cluster): Free[] {
  return c.nodes.map((node) => {
    const free: Free = { node, cpus: node.cpus, memGb: node.memGb, gpuIds: Array.from({ length: node.gpus }, (_, i) => i) };
    for (const j of c.jobs) {
      if (j.state !== "RUNNING" || j.node !== node.name) continue;
      free.cpus -= j.cpus;
      free.memGb -= j.memGb;
      free.gpuIds = free.gpuIds.filter((g) => !(j.gpuIds ?? []).includes(g));
    }
    return free;
  });
}

/** Best fit: the up node that leaves the fewest GPUs, then CPUs, idle. */
export function pickNode(job: Job, free: Free[]): Free | undefined {
  return free
    .filter((f) => f.node.partition === job.partition && f.node.state === "up" && fitsFree(job, f))
    .sort((a, b) => a.gpuIds.length - job.gpus - (b.gpuIds.length - job.gpus) || a.cpus - b.cpus || a.node.name.localeCompare(b.node.name))[0];
}

/** Earliest time the job could start if running jobs end at their time limits (the backfill "shadow time"). */
export function earliestStart(job: Job, free: Free[], running: Running[], now: number): number {
  let best = Infinity;
  for (const f of free) {
    if (f.node.partition !== job.partition || f.node.state !== "up" || !fitsTotal(job, f.node)) continue;
    const sim = { ...f, gpuIds: [...f.gpuIds] };
    if (fitsFree(job, sim)) return now;
    const ending = running.filter((r) => r.node === f.node.name).sort((a, b) => a.expectedEnd - b.expectedEnd);
    for (const r of ending) {
      sim.cpus += r.cpus;
      sim.memGb += r.memGb;
      sim.gpuIds.push(...r.gpuIds);
      if (fitsFree(job, sim)) {
        best = Math.min(best, Math.max(now, r.expectedEnd));
        break;
      }
    }
  }
  return best;
}

export interface Start {
  jobId: number;
  node: string;
  gpuIds: number[];
  backfilled: boolean;
}

export interface Plan {
  starts: Start[];
  reasons: Record<number, string>;
  factors: Record<number, PriorityFactors>;
}

export function planSchedule(c: Cluster): Plan {
  const s = c.settings;
  const now = c.now;
  const usage = decayedUsage(c.jobs, now, s);
  const plan: Plan = { starts: [], reasons: {}, factors: {} };

  const pending = c.jobs.filter((j) => j.state === "PENDING");
  for (const j of pending) plan.factors[j.id] = priorityFactors(j, now, fairshareFactor(j.account, usage, s.shares), s);
  pending.sort((a, b) => plan.factors[b.id].total - plan.factors[a.id].total || a.id - b.id);

  const free = freeResources(c);
  const running: Running[] = c.jobs
    .filter((j) => j.state === "RUNNING")
    .map((j) => ({
      node: j.node!,
      user: j.user,
      cpus: j.cpus,
      memGb: j.memGb,
      gpus: j.gpus,
      gpuIds: j.gpuIds ?? [],
      expectedEnd: (j.startTime ?? now) + j.timeLimitMin * 60,
    }));
  const shadow: Record<string, number> = {};

  for (const job of pending) {
    const qos = s.qos[job.role];
    const mine = running.filter((r) => r.user === job.user);
    if (mine.length >= qos.maxRunningJobs) {
      plan.reasons[job.id] = "QOSMaxJobsPerUser";
      continue;
    }
    if (job.gpus > 0 && mine.reduce((a, r) => a + r.gpus, 0) + job.gpus > qos.maxGpusPerUser) {
      plan.reasons[job.id] = "QOSMaxGPUPerUser";
      continue;
    }
    const nodes = c.nodes.filter((n) => n.partition === job.partition);
    if (!nodes.some((n) => n.state === "up" && fitsTotal(job, n))) {
      plan.reasons[job.id] = nodes.some((n) => fitsTotal(job, n)) ? "ReqNodeNotAvail" : "Resources";
      continue;
    }

    const blockedAt = shadow[job.partition];
    const target = pickNode(job, free);
    const canStart = target && (blockedAt === undefined || (s.backfill && now + job.timeLimitMin * 60 <= blockedAt));
    if (canStart) {
      const gpuIds = target.gpuIds.slice(0, job.gpus);
      target.cpus -= job.cpus;
      target.memGb -= job.memGb;
      target.gpuIds = target.gpuIds.slice(job.gpus);
      running.push({ node: target.node.name, user: job.user, cpus: job.cpus, memGb: job.memGb, gpus: job.gpus, gpuIds, expectedEnd: now + job.timeLimitMin * 60 });
      plan.starts.push({ jobId: job.id, node: target.node.name, gpuIds, backfilled: blockedAt !== undefined });
      plan.reasons[job.id] = blockedAt !== undefined ? "Backfilled" : "Started";
    } else if (blockedAt === undefined) {
      shadow[job.partition] = earliestStart(job, free, running, now);
      plan.reasons[job.id] = "Resources";
    } else {
      plan.reasons[job.id] = "Priority";
    }
  }
  return plan;
}

export const REASON_HELP: Record<string, string> = {
  Queued: "Waiting for the next scheduling pass.",
  Resources: "Highest-priority job in its partition; waiting for enough CPUs, memory or GPUs to free up. Resources are reserved for it.",
  Priority: "Higher-priority jobs are ahead in the queue.",
  QOSMaxJobsPerUser: "The user already runs the maximum number of jobs allowed for the role.",
  QOSMaxGPUPerUser: "Starting this job would exceed the GPUs allowed per user for the role.",
  ReqNodeNotAvail: "Every node that could run the job is drained or down.",
  "Scheduler paused": "The scheduler automation is switched off.",
};
