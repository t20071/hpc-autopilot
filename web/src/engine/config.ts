import type { Cluster, Node, Role, Settings } from "./types";

export const ROLES: Role[] = ["student", "phd", "faculty", "startup"];
export const ROLE_LABEL: Record<Role, string> = {
  student: "Student",
  phd: "PhD scholar",
  faculty: "Faculty",
  startup: "Incubated startup",
};

export const DEFAULT_NODES: Omit<Node, "state" | "reason" | "drainSource" | "fault" | "temp">[] = [
  { name: "gpu01", partition: "gpu", cpus: 32, memGb: 256, gpus: 4, gpuType: "NVIDIA H100" },
  { name: "gpu02", partition: "gpu", cpus: 32, memGb: 256, gpus: 4, gpuType: "NVIDIA H100" },
  { name: "amd01", partition: "gpu", cpus: 32, memGb: 384, gpus: 4, gpuType: "AMD MI300X" },
  { name: "cpu01", partition: "cpu", cpus: 64, memGb: 512, gpus: 0, gpuType: "" },
];

export function defaultSettings(): Settings {
  return {
    backfill: true,
    weights: { fairshare: 10000, age: 1000, qos: 2000 },
    ageSaturationMin: 10,
    halflifeH: 24,
    gpuBillingWeight: 16,
    qos: {
      student: { priority: 0, maxGpusPerUser: 1, maxRunningJobs: 2, maxTimeMin: 30 },
      phd: { priority: 50, maxGpusPerUser: 2, maxRunningJobs: 4, maxTimeMin: 120 },
      faculty: { priority: 100, maxGpusPerUser: 4, maxRunningJobs: 6, maxTimeMin: 240 },
      startup: { priority: 25, maxGpusPerUser: 4, maxRunningJobs: 4, maxTimeMin: 120 },
    },
    shares: { research: 50, teaching: 30, startups: 20 },
    tempLimit: 85,
    autoResume: true,
    backupEveryMin: 60,
    reportEveryMin: 60,
    purgeAfterDays: 7,
    adminEmail: "hpc-admin@example.edu",
    realEmail: false,
    automations: { scheduler: true, health: true, notify: true, maintenance: true, traffic: false },
  };
}

export function makeNode(spec: (typeof DEFAULT_NODES)[number]): Node {
  return { ...spec, state: "up", reason: "", drainSource: "", fault: "", temp: 33 };
}

export function createCluster(now = Date.now() / 1000): Cluster {
  return {
    version: 1,
    now,
    speed: 20,
    paused: false,
    nextId: { job: 1001, email: 1, event: 1 },
    jobs: [],
    nodes: DEFAULT_NODES.map(makeNode),
    emails: [],
    events: [],
    snapshots: [],
    backups: [],
    reports: [],
    uploads: [],
    settings: defaultSettings(),
    meta: { lastBackup: now, lastReport: now, lastPurge: now, lastHealth: 0, nextTraffic: now + 60, started: now },
  };
}

export const partitions = (c: Cluster) => [...new Set(c.nodes.map((n) => n.partition))];
