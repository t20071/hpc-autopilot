// The autopilot: every call to step() runs one pass of health checks, job accounting,
// scheduling, notification and maintenance, with no human in the loop.
import { planSchedule, freeResources } from "./policy";
import { WORKLOADS, isUpload, parseArgs, scriptPath, uploadId, workloadById } from "./workloads";
import { usageByUser } from "./queries";
import type { Cluster, Fault, Job, JobRequest, JobState, Level, Node } from "./types";
import { TERMINAL } from "./types";
import { ROLES } from "./config";

const MAX_EVENTS = 600;
const MAX_EMAILS = 400;
const MAX_SNAPSHOTS = 300;
const MAX_FINISHED = 400;

export function logEvent(c: Cluster, level: Level, category: string, message: string) {
  c.events.unshift({ id: c.nextId.event++, time: c.now, level, category, message });
  if (c.events.length > MAX_EVENTS) c.events.length = MAX_EVENTS;
}

export function fmtTime(t: number | undefined) {
  if (t === undefined) return "-";
  return new Date(t * 1000).toLocaleString("en-GB", { hour12: false });
}

export function fmtDuration(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function sendEmail(c: Cluster, to: string, subject: string, body: string, kind: "user" | "admin", jobId?: number) {
  c.emails.unshift({
    id: c.nextId.email++,
    time: c.now,
    to,
    subject,
    body,
    kind,
    jobId,
    read: false,
    delivery: c.settings.realEmail ? "queued" : "outbox",
  });
  if (c.emails.length > MAX_EMAILS) c.emails.length = MAX_EMAILS;
}

function alertAdmin(c: Cluster, subject: string, body: string) {
  sendEmail(c, c.settings.adminEmail, `[HPC alert] ${subject}`, `${body}\n\nThis alert was raised automatically by HPC Autopilot at ${fmtTime(c.now)}.`, "admin");
}

// ---------------------------------------------------------------- submission

export function validate(c: Cluster, r: JobRequest): string[] {
  const errors: string[] = [];
  const qos = ROLES.includes(r.role) ? c.settings.qos[r.role] : undefined;
  if (!r.name.trim() || r.name.length > 80) errors.push("Give the job a name (at most 80 characters).");
  if (!/^[a-z][a-z0-9_.-]{1,31}$/i.test(r.user)) errors.push("Username must be 2-32 letters, digits, dots, dashes or underscores.");
  if (r.mail && !/^[^\s@<>,;"']+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(r.email)) errors.push("Enter a valid email address.");
  if (!Object.hasOwn(c.settings.shares, r.account)) errors.push(`Unknown account "${r.account}".`);
  if (!qos) errors.push(`Unknown role "${r.role}".`);
  const known = isUpload(r.workload) ? c.uploads.some((u) => uploadId(u.user, u.name) === r.workload) : WORKLOADS.some((w) => w.id === r.workload);
  if (!known) errors.push(isUpload(r.workload) ? "That uploaded script no longer exists. Upload it again." : `Unknown workload "${r.workload}".`);
  const nodes = c.nodes.filter((n) => n.partition === r.partition);
  if (!nodes.length) errors.push(`Unknown partition "${r.partition}".`);
  if (![r.cpus, r.memGb, r.gpus].every(Number.isInteger) || r.cpus < 1 || r.memGb < 1 || r.gpus < 0)
    errors.push("CPUs, memory and GPUs must be whole numbers (CPUs and memory at least 1).");
  if (!Number.isFinite(r.timeLimitMin) || r.timeLimitMin <= 0) errors.push("The time limit must be a positive number of minutes.");
  if (nodes.length && !nodes.some((n) => r.cpus <= n.cpus && r.memGb <= n.memGb && r.gpus <= n.gpus))
    errors.push(`No node in partition "${r.partition}" has ${r.cpus} CPUs, ${r.memGb} GB and ${r.gpus} GPUs.`);
  if (qos && r.timeLimitMin > qos.maxTimeMin) errors.push(`The ${r.role} role allows at most ${qos.maxTimeMin} minutes per job.`);
  if (qos && r.gpus > qos.maxGpusPerUser) errors.push(`The ${r.role} role allows at most ${qos.maxGpusPerUser} GPUs per user.`);
  return errors;
}

export function submitJob(c: Cluster, r: JobRequest): number {
  const errors = validate(c, r);
  if (errors.length) throw new Error(errors.join(" "));
  const args = parseArgs(r.args);
  const plan = workloadById(r.workload).plan(args);
  const job: Job = {
    ...r,
    name: r.name.trim(),
    id: c.nextId.job++,
    state: "PENDING",
    reason: "Queued",
    priority: 0,
    submitTime: c.now,
    runtimeS: plan.runtimeS,
    failAtS: plan.failAtS,
    attempt: 1,
    backfilled: false,
    notified: false,
    logStep: 0,
    log: [],
  };
  c.jobs.push(job);
  logEvent(c, "info", "submit", `Job ${job.id} "${job.name}" submitted by ${job.user} (${job.role}) to ${job.partition}: ${job.cpus} CPU, ${job.memGb} GB, ${job.gpus} GPU, ${job.timeLimitMin} min`);
  return job.id;
}

export function cancelJob(c: Cluster, id: number, by = "admin"): string {
  const job = c.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`Job ${id} not found.`);
  if (TERMINAL.includes(job.state)) throw new Error(`Job ${id} already ${job.state.toLowerCase()}.`);
  const wasRunning = job.state === "RUNNING";
  finish(c, job, "CANCELLED", wasRunning ? 143 : undefined, `Cancelled by ${by}`);
  logEvent(c, "info", "cancel", `Job ${id} cancelled by ${by}${wasRunning ? ` on ${job.node}` : " while pending"}`);
  return `Job ${id} cancelled.`;
}

// ---------------------------------------------------------------- uploads

export const MAX_UPLOAD_BYTES = 200 * 1024;
const MAX_UPLOADS = 20;

/** Store a user's .py script in the browser so it can be picked as a workload. */
export function addUpload(c: Cluster, user: string, filename: string, content: string): string {
  if (!/^[a-z][a-z0-9_.-]{1,31}$/i.test(user)) throw new Error("Enter a valid username first.");
  const name = filename.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+/, "");
  if (!name.toLowerCase().endsWith(".py")) throw new Error("Only Python (.py) files can be run. For a whole project, zip it and use the local Python version.");
  const size = new Blob([content]).size;
  if (size > MAX_UPLOAD_BYTES) throw new Error("Scripts are limited to 200 KB in the web demo.");
  c.uploads = c.uploads.filter((u) => !(u.user === user && u.name === name));
  if (c.uploads.length >= MAX_UPLOADS) throw new Error(`At most ${MAX_UPLOADS} uploads; delete one first.`);
  c.uploads.unshift({ user, name, size, lines: content.split("\n").length, time: c.now, content });
  logEvent(c, "info", "upload", `${user} uploaded ${name} (${(size / 1024).toFixed(1)} KB)`);
  return uploadId(user, name);
}

export function removeUpload(c: Cluster, user: string, name: string) {
  c.uploads = c.uploads.filter((u) => !(u.user === user && u.name === name));
  logEvent(c, "info", "upload", `${user} deleted ${name}`);
}

// ---------------------------------------------------------------- admin actions

const nodeByName = (c: Cluster, name: string) => {
  const n = c.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`Node ${name} not found.`);
  return n;
};

export function drainNode(c: Cluster, name: string, reason = "Maintenance", by = "admin") {
  const n = nodeByName(c, name);
  if (n.state === "down") return `${name} is down; it stays out of service until its fault is cleared.`;
  n.state = "drain";
  n.reason = reason;
  n.drainSource = "admin";
  logEvent(c, "warning", "admin", `${by} drained ${name}: ${reason}`);
  return `${name} drained. Running jobs finish; no new jobs start there.`;
}

export function resumeNode(c: Cluster, name: string, by = "admin") {
  const n = nodeByName(c, name);
  if (n.fault) return `${name} still has a fault (${n.fault}); clear it first.`;
  n.state = "up";
  n.reason = "";
  n.drainSource = "";
  logEvent(c, "info", "admin", `${by} resumed ${name}`);
  return `${name} is accepting jobs again.`;
}

export function setFault(c: Cluster, name: string, fault: Fault, by = "admin") {
  const n = nodeByName(c, name);
  n.fault = fault;
  logEvent(c, fault ? "warning" : "info", "drill", fault ? `${by} injected fault "${fault}" on ${name}` : `${by} cleared the fault on ${name}`);
  return fault ? `Fault injected on ${name}. Watch the health check react.` : `Fault cleared on ${name}. It resumes automatically once healthy.`;
}

export function addNode(c: Cluster, spec: Pick<Node, "name" | "partition" | "cpus" | "memGb" | "gpus" | "gpuType">) {
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(spec.name)) throw new Error("Node name must be 2-16 lowercase letters, digits or dashes.");
  const whole = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!whole(spec.cpus, 1, 256) || !whole(spec.memGb, 1, 4096) || !whole(spec.gpus, 0, 8))
    throw new Error("Use 1-256 CPUs, 1-4096 GB memory and 0-8 GPUs.");
  if (c.nodes.some((n) => n.name === spec.name)) throw new Error(`Node ${spec.name} already exists.`);
  c.nodes.push({ ...spec, state: "up", reason: "", drainSource: "", fault: "", temp: 30 });
  logEvent(c, "info", "admin", `Node ${spec.name} added to partition ${spec.partition}`);
}

export function removeNode(c: Cluster, name: string) {
  nodeByName(c, name);
  if (c.jobs.some((j) => j.state === "RUNNING" && j.node === name)) throw new Error(`${name} still has running jobs; drain it first.`);
  c.nodes = c.nodes.filter((n) => n.name !== name);
  logEvent(c, "warning", "admin", `Node ${name} removed from the cluster`);
}

// ---------------------------------------------------------------- the autopilot loop

const HEADLINE: Record<string, string> = {
  COMPLETED: "Your job is completed.",
  FAILED: "Your job has failed.",
  TIMEOUT: "Your job was stopped because it reached its time limit.",
  CANCELLED: "Your job was cancelled.",
};

function finish(c: Cluster, job: Job, state: JobState, exitCode: number | undefined, line: string) {
  job.state = state;
  job.reason = state === "COMPLETED" ? "" : line;
  job.exitCode = exitCode;
  job.endTime = c.now;
  job.log.push(`[${fmtTime(c.now)}] ${line}`);
}

function appendProgress(job: Job, now: number) {
  const w = workloadById(job.workload);
  const args = parseArgs(job.args);
  const { steps } = w.plan(args);
  const elapsed = now - (job.startTime ?? now);
  const target = Math.min(steps, Math.floor((elapsed / job.runtimeS) * steps));
  while (job.logStep < target) {
    job.logStep++;
    job.log.push(w.line(job.logStep, steps, args));
  }
}

function collect(c: Cluster) {
  for (const job of c.jobs) {
    if (job.state !== "RUNNING") continue;
    const elapsed = c.now - (job.startTime ?? c.now);
    const limit = job.timeLimitMin * 60;
    if (job.failAtS !== null && elapsed >= job.failAtS && job.failAtS < limit) {
      appendProgress(job, (job.startTime ?? 0) + job.failAtS);
      job.log.push("Traceback (most recent call last):\n  RuntimeError: CUDA error: an illegal memory access was encountered");
      finish(c, job, "FAILED", 1, "Process exited with code 1");
      logEvent(c, "error", "job", `Job ${job.id} failed on ${job.node} (exit code 1)`);
    } else if (elapsed >= job.runtimeS && job.runtimeS <= limit) {
      appendProgress(job, c.now);
      finish(c, job, "COMPLETED", 0, "Process exited with code 0");
      logEvent(c, "info", "job", `Job ${job.id} completed on ${job.node} after ${fmtDuration(elapsed)}`);
    } else if (elapsed >= limit) {
      appendProgress(job, c.now);
      finish(c, job, "TIMEOUT", 124, `Time limit of ${job.timeLimitMin} min reached; job stopped`);
      logEvent(c, "warning", "job", `Job ${job.id} hit its ${job.timeLimitMin}-minute limit on ${job.node} and was stopped`);
    } else {
      appendProgress(job, c.now);
    }
  }
}

function schedule(c: Cluster) {
  const plan = planSchedule(c);
  for (const job of c.jobs) {
    if (job.state !== "PENDING") continue;
    if (plan.factors[job.id]) {
      job.factors = plan.factors[job.id];
      job.priority = Math.round(job.factors.total);
    }
    const reason = plan.reasons[job.id];
    if (reason && reason !== "Started" && reason !== "Backfilled") job.reason = reason;
  }
  for (const s of plan.starts) {
    const job = c.jobs.find((j) => j.id === s.jobId)!;
    job.state = "RUNNING";
    job.node = s.node;
    job.gpuIds = s.gpuIds;
    job.startTime = c.now;
    job.backfilled = s.backfilled;
    job.reason = s.backfilled ? "Backfilled" : "";
    job.logStep = 0;
    job.log.push(
      `[${fmtTime(c.now)}] Attempt ${job.attempt}: started on ${s.node}` +
        (s.gpuIds.length ? ` with CUDA_VISIBLE_DEVICES=${s.gpuIds.join(",")}` : "") +
        ` (${job.cpus} CPU, ${job.memGb} GB)`,
      `$ python ${scriptPath(job.workload)} ${job.args}`.trim(),
    );
    const wait = fmtDuration(c.now - job.submitTime);
    logEvent(c, "info", "schedule", `Job ${job.id} ${s.backfilled ? "backfilled" : "started"} on ${s.node}${s.gpuIds.length ? ` (GPU ${s.gpuIds.join(",")})` : ""} after waiting ${wait}`);
  }
}

export function jobEmail(job: Job): { subject: string; body: string } {
  const subject = `[HPC] Job ${job.id} "${job.name}" ${job.state}`;
  const run = job.startTime !== undefined && job.endTime !== undefined ? job.endTime - job.startTime : undefined;
  const wait = job.startTime !== undefined ? job.startTime - job.submitTime : undefined;
  const body = [
    `Hello ${job.user},`,
    "",
    HEADLINE[job.state],
    "",
    `Job ID:      ${job.id}`,
    `Name:        ${job.name}`,
    `State:       ${job.state}${job.exitCode !== undefined ? ` (exit code ${job.exitCode})` : ""}`,
    `Node:        ${job.node ?? "-"}${job.gpuIds?.length ? ` (GPUs ${job.gpuIds.join(",")})` : ""}`,
    `Resources:   ${job.cpus} CPU, ${job.memGb} GB, ${job.gpus} GPU, ${job.timeLimitMin} min limit`,
    `Submitted:   ${fmtTime(job.submitTime)}`,
    `Started:     ${fmtTime(job.startTime)}`,
    `Finished:    ${fmtTime(job.endTime)}`,
    `Queue wait:  ${fmtDuration(wait)}`,
    `Run time:    ${fmtDuration(run)}`,
    "",
    "Last lines of output:",
    ...job.log.slice(-5).map((l) => `  ${l}`),
    "",
    "This message was sent automatically by HPC Autopilot.",
  ].join("\n");
  return { subject, body };
}

function notify(c: Cluster, enabled: boolean) {
  for (const job of c.jobs) {
    if (job.notified || !TERMINAL.includes(job.state)) continue;
    job.notified = true;
    // while notifications are switched off, finished jobs are marked as handled so that
    // switching them back on does not send a burst of stale emails
    if (!job.mail || !enabled) continue;
    const { subject, body } = jobEmail(job);
    sendEmail(c, job.email, subject, body, "user", job.id);
    logEvent(c, "info", "email", `Emailed ${job.email}: job ${job.id} ${job.state.toLowerCase()}`);
  }
}

function requeueFrom(c: Cluster, node: Node) {
  for (const job of c.jobs) {
    if (job.state !== "RUNNING" || job.node !== node.name) continue;
    job.log.push(`[${fmtTime(c.now)}] Node ${node.name} failed; job requeued automatically`);
    job.state = "PENDING";
    job.reason = "Requeued (node failure)";
    job.attempt++;
    job.node = undefined;
    job.gpuIds = undefined;
    job.startTime = undefined;
    job.eligibleTime = c.now - 60 * c.settings.ageSaturationMin; // full age credit: it keeps its place in line
    logEvent(c, "warning", "requeue", `Job ${job.id} requeued after ${node.name} failed (attempt ${job.attempt})`);
  }
}

function health(c: Cluster, dt: number) {
  const s = c.settings;
  const free = freeResources(c);
  for (const n of c.nodes) {
    const f = free.find((x) => x.node.name === n.name)!;
    const util = n.gpus ? (n.gpus - f.gpuIds.length) / n.gpus : (n.cpus - f.cpus) / n.cpus;
    const target = n.state === "down" ? 24 : 34 + 42 * util + (n.fault === "gpu_overheat" ? 26 : 0);
    n.temp += (target - n.temp) * Math.min(1, dt / 15) + (Math.random() - 0.5) * 0.6;

    if (n.fault === "node_down") {
      if (n.state !== "down") {
        n.state = "down";
        n.reason = "Not responding to heartbeat";
        n.drainSource = "health";
        logEvent(c, "error", "health", `${n.name} stopped responding; marked DOWN`);
        requeueFrom(c, n);
        alertAdmin(c, `${n.name} is DOWN`, `${n.name} stopped responding to the health check. Its running jobs were requeued and will restart on other nodes.\n\nAction: inspect the node (power, BMC, network) and clear the fault.`);
      }
      continue;
    }
    const problem = n.fault === "ecc_error" ? "Uncorrectable GPU ECC error" : n.temp > s.tempLimit ? `GPU temperature ${n.temp.toFixed(0)} C above ${s.tempLimit} C` : "";
    if (problem && n.state === "up") {
      n.state = "drain";
      n.reason = problem;
      n.drainSource = "health";
      logEvent(c, "warning", "health", `${n.name} drained automatically: ${problem}`);
      alertAdmin(c, `${n.name} drained: ${problem}`, `The health check drained ${n.name} because: ${problem}.\nRunning jobs continue; no new jobs will start there.\n\nIt resumes automatically once the check passes.`);
    } else if (!problem && n.state !== "up" && n.drainSource === "health" && s.autoResume && n.temp < s.tempLimit - 5) {
      n.state = "up";
      n.reason = "";
      n.drainSource = "";
      logEvent(c, "info", "health", `${n.name} passed the health check and was resumed automatically`);
      alertAdmin(c, `${n.name} resumed`, `${n.name} passed its health check and is accepting jobs again.`);
    }
  }
  c.meta.lastHealth = c.now;
}

export function backupNow(c: Cluster, manual = false) {
  const sizeKb = Math.round(JSON.stringify(c).length / 1024);
  c.backups.unshift({ time: c.now, jobs: c.jobs.length, events: c.events.length, sizeKb });
  c.backups.length = Math.min(c.backups.length, 10);
  c.meta.lastBackup = c.now;
  logEvent(c, "info", "maintenance", `${manual ? "Manual" : "Scheduled"} backup of the job database (${sizeKb} KB, ${c.jobs.length} jobs)`);
}

export function reportNow(c: Cluster, manual = false) {
  c.reports.unshift({ time: c.now, rows: usageByUser(c) });
  c.reports.length = Math.min(c.reports.length, 10);
  c.meta.lastReport = c.now;
  logEvent(c, "info", "maintenance", `${manual ? "Manual" : "Scheduled"} utilisation report written (${c.reports[0].rows.length} users)`);
}

function maintenance(c: Cluster) {
  const s = c.settings;
  if (c.now - c.meta.lastBackup >= s.backupEveryMin * 60) backupNow(c);
  if (c.now - c.meta.lastReport >= s.reportEveryMin * 60) reportNow(c);
  if (c.now - c.meta.lastPurge >= 86400) {
    let purged = 0;
    for (const j of c.jobs) {
      if (j.endTime && c.now - j.endTime > s.purgeAfterDays * 86400 && j.log.length) {
        j.log = ["(output purged by retention policy)"];
        purged++;
      }
    }
    c.meta.lastPurge = c.now;
    logEvent(c, "info", "maintenance", `Retention check: purged output of ${purged} job(s) older than ${s.purgeAfterDays} days`);
  }
  const finished = c.jobs.filter((j) => TERMINAL.includes(j.state) && j.notified);
  if (finished.length > MAX_FINISHED) {
    const drop = new Set(finished.slice(0, finished.length - MAX_FINISHED).map((j) => j.id));
    c.jobs = c.jobs.filter((j) => !drop.has(j.id));
  }
}

export function step(c: Cluster, dt: number, traffic?: (c: Cluster) => void) {
  c.now += dt;
  const a = c.settings.automations;
  if (a.health) health(c, dt);
  collect(c);
  if (a.scheduler) schedule(c);
  else for (const j of c.jobs) if (j.state === "PENDING") j.reason = "Scheduler paused";
  notify(c, a.notify);
  if (a.maintenance) maintenance(c);
  if (a.traffic && traffic && c.now >= c.meta.nextTraffic) {
    traffic(c);
    c.meta.nextTraffic = c.now + 45 + Math.random() * 120;
  }
}

export function snapshot(c: Cluster) {
  const free = freeResources(c);
  const up = c.nodes.filter((n) => n.state !== "down");
  const gpus = up.reduce((a, n) => a + n.gpus, 0);
  const cpus = up.reduce((a, n) => a + n.cpus, 0);
  const usedG = free.filter((f) => f.node.state !== "down").reduce((a, f) => a + f.node.gpus - f.gpuIds.length, 0);
  const usedC = free.filter((f) => f.node.state !== "down").reduce((a, f) => a + f.node.cpus - f.cpus, 0);
  c.snapshots.push({
    t: c.now,
    gpuPct: gpus ? (100 * usedG) / gpus : 0,
    cpuPct: cpus ? (100 * usedC) / cpus : 0,
    running: c.jobs.filter((j) => j.state === "RUNNING").length,
    pending: c.jobs.filter((j) => j.state === "PENDING").length,
    nodesUp: c.nodes.filter((n) => n.state === "up").length,
  });
  if (c.snapshots.length > MAX_SNAPSHOTS) c.snapshots.splice(0, c.snapshots.length - MAX_SNAPSHOTS);
}
