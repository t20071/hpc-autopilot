import { billing, decayedUsage, fairshareFactor, freeResources } from "./policy";
import { scriptPath } from "./workloads";
import type { Cluster, Job, Node, UsageRow } from "./types";

const hours = (j: Job, now: number) => (j.startTime === undefined ? 0 : ((j.endTime ?? now) - j.startTime) / 3600);

export function summary(c: Cluster) {
  const free = freeResources(c);
  const live = free.filter((f) => f.node.state !== "down");
  const done = c.jobs.filter((j) => j.state === "COMPLETED").length;
  const ended = c.jobs.filter((j) => j.endTime !== undefined && j.startTime !== undefined);
  const waits = c.jobs.filter((j) => j.startTime !== undefined).map((j) => j.startTime! - j.submitTime);
  return {
    running: c.jobs.filter((j) => j.state === "RUNNING").length,
    pending: c.jobs.filter((j) => j.state === "PENDING").length,
    completed: done,
    failed: c.jobs.filter((j) => j.state === "FAILED" || j.state === "TIMEOUT").length,
    gpusTotal: live.reduce((a, f) => a + f.node.gpus, 0),
    gpusUsed: live.reduce((a, f) => a + f.node.gpus - f.gpuIds.length, 0),
    cpusTotal: live.reduce((a, f) => a + f.node.cpus, 0),
    cpusUsed: live.reduce((a, f) => a + f.node.cpus - f.cpus, 0),
    nodesUp: c.nodes.filter((n) => n.state === "up").length,
    nodesTotal: c.nodes.length,
    avgWaitS: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
    successRate: ended.length ? done / ended.length : 1,
    emails: c.emails.length,
  };
}

export type NodeStatusLabel = "idle" | "mixed" | "allocated" | "draining" | "drained" | "down";

export function nodeView(c: Cluster) {
  return freeResources(c).map((f) => {
    const n: Node = f.node;
    const jobs = c.jobs.filter((j) => j.state === "RUNNING" && j.node === n.name);
    const usedCpus = n.cpus - f.cpus;
    const usedGpus = n.gpus - f.gpuIds.length;
    let status: NodeStatusLabel;
    if (n.state === "down") status = "down";
    else if (n.state === "drain") status = jobs.length ? "draining" : "drained";
    else if (!jobs.length) status = "idle";
    else if ((n.gpus ? usedGpus === n.gpus : false) || usedCpus === n.cpus) status = "allocated";
    else status = "mixed";
    const gpuOwner: (Job | undefined)[] = Array.from({ length: n.gpus }, (_, i) => jobs.find((j) => j.gpuIds?.includes(i)));
    return { node: n, jobs, usedCpus, usedGpus, usedMem: n.memGb - f.memGb, status, gpuOwner };
  });
}

export function usageByAccount(c: Cluster) {
  const s = c.settings;
  const usage = decayedUsage(c.jobs, c.now, s);
  const total = Object.values(usage).reduce((a, b) => a + b, 0);
  const totalShares = Object.values(s.shares).reduce((a, b) => a + b, 0) || 1;
  return Object.keys(s.shares).map((account) => {
    const jobs = c.jobs.filter((j) => j.account === account);
    return {
      account,
      jobs: jobs.length,
      gpuHours: jobs.reduce((a, j) => a + j.gpus * hours(j, c.now), 0),
      cpuHours: jobs.reduce((a, j) => a + j.cpus * hours(j, c.now), 0),
      billingHours: jobs.reduce((a, j) => a + billing(j, s) * hours(j, c.now), 0),
      targetShare: s.shares[account] / totalShares,
      recentUsage: total ? (usage[account] ?? 0) / total : 0,
      fairshare: fairshareFactor(account, usage, s.shares),
    };
  });
}

export function usageByUser(c: Cluster): UsageRow[] {
  const map = new Map<string, Job[]>();
  for (const j of c.jobs) map.set(j.user, [...(map.get(j.user) ?? []), j]);
  return [...map.entries()]
    .map(([user, jobs]) => {
      const started = jobs.filter((j) => j.startTime !== undefined);
      return {
        user,
        account: jobs[jobs.length - 1].account,
        role: jobs[jobs.length - 1].role,
        jobs: jobs.length,
        completed: jobs.filter((j) => j.state === "COMPLETED").length,
        failed: jobs.filter((j) => j.state === "FAILED" || j.state === "TIMEOUT").length,
        gpuHours: +jobs.reduce((a, j) => a + j.gpus * hours(j, c.now), 0).toFixed(3),
        cpuHours: +jobs.reduce((a, j) => a + j.cpus * hours(j, c.now), 0).toFixed(3),
        avgWaitMin: started.length ? +(started.reduce((a, j) => a + (j.startTime! - j.submitTime), 0) / started.length / 60).toFixed(2) : 0,
      };
    })
    .sort((a, b) => b.gpuHours - a.gpuHours || b.cpuHours - a.cpuHours);
}

export function outcomes(c: Cluster) {
  const states = ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"] as const;
  return states.map((state) => ({ state, count: c.jobs.filter((j) => j.state === state).length }));
}

export function toCsv(rows: object[]): string {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`; // stop spreadsheets running user text as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((k) => esc((r as Record<string, unknown>)[k])).join(","))].join("\n");
}

export function sbatchScript(j: Pick<Job, "name" | "account" | "role" | "partition" | "cpus" | "memGb" | "gpus" | "timeLimitMin" | "mail" | "email" | "workload" | "args">) {
  const h = Math.floor(j.timeLimitMin / 60);
  const m = Math.floor(j.timeLimitMin % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    "#!/bin/bash",
    `#SBATCH --job-name=${j.name}`,
    `#SBATCH --account=${j.account}`,
    `#SBATCH --qos=${j.role}`,
    `#SBATCH --partition=${j.partition}`,
    `#SBATCH --cpus-per-task=${j.cpus}`,
    `#SBATCH --mem=${j.memGb}G`,
    ...(j.gpus ? [`#SBATCH --gres=gpu:${j.gpus}`] : []),
    `#SBATCH --time=${pad(h)}:${pad(m)}:00`,
    ...(j.mail ? ["#SBATCH --mail-type=END,FAIL", `#SBATCH --mail-user=${j.email}`] : []),
    "#SBATCH --output=%x-%j.out",
    "",
    j.gpus ? "module load cuda python" : "module load python",
    `srun python ${scriptPath(j.workload)} ${j.args}`.trim(),
  ].join("\n");
}
