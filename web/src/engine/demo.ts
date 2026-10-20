import { submitJob } from "./engine";
import { WORKLOADS } from "./workloads";
import type { Cluster, JobRequest, Role } from "./types";

type Demo = Omit<JobRequest, "email" | "mail">;

const domain: Record<Role, string> = {
  student: "students.example.edu",
  phd: "phd.example.edu",
  faculty: "faculty.example.edu",
  startup: "incubator.example.edu",
};

export const DEMO_JOBS: Demo[] = [
  { name: "mba-churn-model", user: "asha", role: "student", account: "teaching", partition: "gpu", cpus: 4, memGb: 16, gpus: 1, timeLimitMin: 20, workload: "train_model", args: "--epochs 6 --minutes-per-epoch 1.5" },
  { name: "mba-churn-tuning", user: "asha", role: "student", account: "teaching", partition: "gpu", cpus: 4, memGb: 16, gpus: 1, timeLimitMin: 20, workload: "train_model", args: "--epochs 5 --minutes-per-epoch 1" },
  { name: "finbert-sentiment", user: "rahul", role: "phd", account: "research", partition: "gpu", cpus: 8, memGb: 64, gpus: 2, timeLimitMin: 60, workload: "llm_finetune", args: "--steps 900 --seconds-per-step 1" },
  { name: "finbert-ablation", user: "rahul", role: "phd", account: "research", partition: "gpu", cpus: 8, memGb: 64, gpus: 2, timeLimitMin: 60, workload: "llm_finetune", args: "--steps 600 --seconds-per-step 1" },
  { name: "supply-chain-gnn", user: "lin", role: "phd", account: "research", partition: "gpu", cpus: 8, memGb: 48, gpus: 1, timeLimitMin: 30, workload: "train_model", args: "--epochs 10 --minutes-per-epoch 1 --fail-at 4" },
  { name: "household-survey-etl", user: "kavya", role: "phd", account: "research", partition: "cpu", cpus: 16, memGb: 64, gpus: 0, timeLimitMin: 30, workload: "data_prep", args: "--rows 3000000" },
  { name: "llm-policy-assistant", user: "prof_mehta", role: "faculty", account: "research", partition: "gpu", cpus: 16, memGb: 128, gpus: 4, timeLimitMin: 90, workload: "llm_finetune", args: "--steps 1500 --seconds-per-step 1.2" },
  { name: "option-pricing-mc", user: "prof_mehta", role: "faculty", account: "research", partition: "cpu", cpus: 32, memGb: 64, gpus: 0, timeLimitMin: 20, workload: "monte_carlo_pi", args: "--samples 90000000" },
  { name: "retail-demand-forecast", user: "neo_ai", role: "startup", account: "startups", partition: "gpu", cpus: 8, memGb: 64, gpus: 2, timeLimitMin: 45, workload: "train_model", args: "--epochs 12 --minutes-per-epoch 2" },
  { name: "quick-eda-timeout", user: "asha", role: "student", account: "teaching", partition: "cpu", cpus: 2, memGb: 8, gpus: 0, timeLimitMin: 1, workload: "data_prep", args: "--rows 2500000" },
];

export function submitDemoBatch(c: Cluster): number[] {
  return DEMO_JOBS.map((d) => submitJob(c, { ...d, email: `${d.user}@${domain[d.role]}`, mail: true }));
}

const PEOPLE: [string, Role, string][] = [
  ["asha", "student", "teaching"],
  ["vikram", "student", "teaching"],
  ["meera", "student", "teaching"],
  ["rahul", "phd", "research"],
  ["lin", "phd", "research"],
  ["kavya", "phd", "research"],
  ["prof_mehta", "faculty", "research"],
  ["prof_iyer", "faculty", "research"],
  ["neo_ai", "startup", "startups"],
];

/** Synthetic workload: a random user submits a random, valid job. */
export function randomJob(c: Cluster) {
  const [user, role, account] = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
  const w = WORKLOADS[Math.floor(Math.random() * WORKLOADS.length)];
  const q = c.settings.qos[role];
  const gpus = w.gpus ? Math.min(q.maxGpusPerUser, w.gpus + (Math.random() < 0.3 ? 1 : 0)) : 0;
  try {
    submitJob(c, {
      name: `${w.id.replace(/_/g, "-")}-${Math.floor(Math.random() * 900 + 100)}`,
      user,
      email: `${user}@${domain[role]}`,
      role,
      account,
      partition: w.partition,
      cpus: w.partition === "cpu" ? 8 * (1 + Math.floor(Math.random() * 3)) : 4 * gpus || 4,
      memGb: 32,
      gpus,
      timeLimitMin: Math.min(q.maxTimeMin, 30),
      workload: w.id,
      args: w.defaultArgs,
      mail: true,
    });
  } catch {
    /* a node layout without that partition: skip this arrival */
  }
}
