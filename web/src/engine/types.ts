export type Role = "student" | "phd" | "faculty" | "startup";
export type JobState = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "CANCELLED";
export type NodeStatus = "up" | "drain" | "down";
export type Fault = "" | "gpu_overheat" | "ecc_error" | "node_down";
export type Level = "info" | "warning" | "error";
export type AutomationKey = "scheduler" | "health" | "notify" | "maintenance" | "traffic";

export const TERMINAL: JobState[] = ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"];

export interface PriorityFactors {
  fairshare: number;
  age: number;
  qos: number;
  total: number;
}

export interface Job {
  id: number;
  name: string;
  user: string;
  email: string;
  role: Role;
  account: string;
  partition: string;
  cpus: number;
  memGb: number;
  gpus: number;
  timeLimitMin: number;
  workload: string;
  args: string;
  mail: boolean;
  state: JobState;
  reason: string;
  priority: number;
  factors?: PriorityFactors;
  node?: string;
  gpuIds?: number[];
  submitTime: number;
  /** When the job (re)entered the queue; drives the age factor. Defaults to submitTime. */
  eligibleTime?: number;
  startTime?: number;
  endTime?: number;
  runtimeS: number;
  failAtS: number | null;
  exitCode?: number;
  attempt: number;
  backfilled: boolean;
  notified: boolean;
  logStep: number;
  log: string[];
}

export interface Node {
  name: string;
  partition: string;
  cpus: number;
  memGb: number;
  gpus: number;
  gpuType: string;
  state: NodeStatus;
  reason: string;
  drainSource: "" | "admin" | "health";
  fault: Fault;
  temp: number;
}

export interface Email {
  id: number;
  time: number;
  to: string;
  subject: string;
  body: string;
  kind: "user" | "admin";
  delivery: "outbox" | "queued" | "sending" | "sent" | "failed";
  jobId?: number;
  read: boolean;
}

export interface LogEvent {
  id: number;
  time: number;
  level: Level;
  category: string;
  message: string;
}

export interface Snapshot {
  t: number;
  gpuPct: number;
  cpuPct: number;
  running: number;
  pending: number;
  nodesUp: number;
}

export interface Qos {
  priority: number;
  maxGpusPerUser: number;
  maxRunningJobs: number;
  maxTimeMin: number;
}

export interface Settings {
  backfill: boolean;
  weights: { fairshare: number; age: number; qos: number };
  ageSaturationMin: number;
  halflifeH: number;
  gpuBillingWeight: number;
  qos: Record<Role, Qos>;
  shares: Record<string, number>;
  tempLimit: number;
  autoResume: boolean;
  backupEveryMin: number;
  reportEveryMin: number;
  purgeAfterDays: number;
  adminEmail: string;
  realEmail: boolean;
  automations: Record<AutomationKey, boolean>;
}

export interface Backup {
  time: number;
  jobs: number;
  events: number;
  sizeKb: number;
}

export interface UsageRow {
  user: string;
  account: string;
  role: string;
  jobs: number;
  completed: number;
  failed: number;
  gpuHours: number;
  cpuHours: number;
  avgWaitMin: number;
}

/** A user's script, kept in the browser. The web demo simulates its run; it never executes it. */
export interface Upload {
  user: string;
  name: string;
  size: number;
  lines: number;
  time: number;
  content: string;
}

export interface Report {
  time: number;
  rows: UsageRow[];
}

export interface Cluster {
  version: number;
  now: number;
  speed: number;
  paused: boolean;
  nextId: { job: number; email: number; event: number };
  jobs: Job[];
  nodes: Node[];
  emails: Email[];
  events: LogEvent[];
  snapshots: Snapshot[];
  backups: Backup[];
  reports: Report[];
  uploads: Upload[];
  settings: Settings;
  meta: { lastBackup: number; lastReport: number; lastPurge: number; lastHealth: number; nextTraffic: number; started: number };
}

export interface JobRequest {
  name: string;
  user: string;
  email: string;
  role: Role;
  account: string;
  partition: string;
  cpus: number;
  memGb: number;
  gpus: number;
  timeLimitMin: number;
  workload: string;
  args: string;
  mail: boolean;
}
