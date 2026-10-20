import { describe, expect, it } from "vitest";
import { createCluster } from "./config";
import { addUpload, cancelJob, removeUpload, setFault, step, submitJob } from "./engine";
import { submitDemoBatch } from "./demo";
import { fairshareFactor } from "./policy";
import type { Cluster, JobRequest } from "./types";
import { normalize } from "./store";

const base: JobRequest = {
  name: "t", user: "asha", email: "asha@example.edu", role: "faculty", account: "research", partition: "gpu",
  cpus: 4, memGb: 16, gpus: 1, timeLimitMin: 10, workload: "train_model", args: "--epochs 2 --minutes-per-epoch 1", mail: true,
};

function run(c: Cluster, seconds: number) {
  for (let t = 0; t < seconds; t += 5) step(c, 5);
}

describe("autopilot", () => {
  it("queues, schedules, runs and emails 'Your job is completed.'", () => {
    const c = createCluster(0);
    const id = submitJob(c, base);
    expect(c.jobs[0].state).toBe("PENDING");
    step(c, 5);
    expect(c.jobs[0].state).toBe("RUNNING");
    run(c, 150);
    const job = c.jobs.find((j) => j.id === id)!;
    expect(job.state).toBe("COMPLETED");
    expect(c.emails[0].to).toBe("asha@example.edu");
    expect(c.emails[0].body).toContain("Your job is completed.");
  });

  it("marks failures and timeouts", () => {
    const c = createCluster(0);
    submitJob(c, { ...base, args: "--epochs 5 --minutes-per-epoch 1 --fail-at 2" });
    submitJob(c, { ...base, user: "lin", timeLimitMin: 1, args: "--epochs 5 --minutes-per-epoch 1" });
    run(c, 400);
    expect(c.jobs.map((j) => j.state)).toEqual(["FAILED", "TIMEOUT"]);
  });

  it("enforces per-role GPU limits", () => {
    const c = createCluster(0);
    submitJob(c, { ...base, role: "student", account: "teaching", timeLimitMin: 20 });
    submitJob(c, { ...base, role: "student", account: "teaching", timeLimitMin: 20 });
    step(c, 5);
    expect(c.jobs[1].reason).toBe("QOSMaxGPUPerUser");
  });

  it("backfills a short job but not a long one", () => {
    const c = createCluster(0);
    c.nodes = c.nodes.filter((n) => n.name === "gpu01");
    submitJob(c, { ...base, user: "ua", gpus: 3, timeLimitMin: 60, args: "--epochs 50" });
    step(c, 5);
    submitJob(c, { ...base, user: "ub", gpus: 4, timeLimitMin: 60 }); // blocked -> reservation
    submitJob(c, { ...base, user: "uc", gpus: 1, timeLimitMin: 120, args: "--epochs 50" }); // would delay b
    submitJob(c, { ...base, user: "ud", gpus: 1, timeLimitMin: 10 }); // fits before shadow
    step(c, 5);
    const [, b, long, short] = c.jobs;
    expect(b.reason).toBe("Resources");
    expect(long.state).toBe("PENDING");
    expect(short.state).toBe("RUNNING");
    expect(short.backfilled).toBe(true);
  });

  it("drains a failed node, requeues its jobs and resumes it", () => {
    const c = createCluster(0);
    c.nodes = c.nodes.filter((n) => n.name === "gpu01" || n.name === "gpu02");
    submitJob(c, { ...base, args: "--epochs 20" });
    step(c, 5);
    const node = c.jobs[0].node!;
    setFault(c, node, "node_down");
    step(c, 5);
    expect(c.nodes.find((n) => n.name === node)!.state).toBe("down");
    expect(c.jobs[0].attempt).toBe(2);
    step(c, 5);
    expect(c.jobs[0].state).toBe("RUNNING");
    expect(c.jobs[0].node).not.toBe(node);
    setFault(c, node, "");
    run(c, 60);
    expect(c.nodes.find((n) => n.name === node)!.state).toBe("up");
    expect(c.emails.some((e) => e.kind === "admin" && e.subject.includes("DOWN"))).toBe(true);
  });

  it("cancels pending jobs and runs the demo batch to completion", () => {
    const c = createCluster(0);
    const ids = submitDemoBatch(c);
    cancelJob(c, ids[1]);
    run(c, 4 * 3600);
    const states = Object.fromEntries(c.jobs.map((j) => [j.name, j.state]));
    expect(states["mba-churn-tuning"]).toBe("CANCELLED");
    expect(states["supply-chain-gnn"]).toBe("FAILED");
    expect(states["quick-eda-timeout"]).toBe("TIMEOUT");
    expect(c.jobs.filter((j) => j.state === "COMPLETED")).toHaveLength(7);
    expect(c.emails.filter((e) => e.kind === "user")).toHaveLength(10);
  });

  it("rejects prototype keys and non-numeric resources", () => {
    const c = createCluster(0);
    expect(() => submitJob(c, { ...base, role: "constructor" as never })).toThrow(/Unknown role/);
    expect(() => submitJob(c, { ...base, account: "toString" })).toThrow(/Unknown account/);
    expect(() => submitJob(c, { ...base, timeLimitMin: Number.NaN })).toThrow(/time limit/);
    expect(() => submitJob(c, { ...base, gpus: 0.5 })).toThrow(/whole numbers/);
    expect(() => submitJob(c, { ...base, email: "a@x.edu,b@y.com" })).toThrow(/email/);
  });

  it("does not send a burst of old emails when notifications are switched back on", () => {
    const c = createCluster(0);
    c.settings.automations.notify = false;
    submitJob(c, base);
    run(c, 200);
    expect(c.jobs[0].state).toBe("COMPLETED");
    c.settings.automations.notify = true;
    run(c, 10);
    expect(c.emails.filter((e) => e.kind === "user")).toHaveLength(0);
  });

  it("keeps the original submit time when a job is requeued", () => {
    const c = createCluster(1000);
    c.nodes = c.nodes.filter((n) => n.name === "gpu01" || n.name === "gpu02");
    submitJob(c, { ...base, args: "--epochs 20" });
    step(c, 5);
    setFault(c, c.jobs[0].node!, "node_down");
    step(c, 5);
    expect(c.jobs[0].attempt).toBe(2);
    expect(c.jobs[0].submitTime).toBe(1000);
  });

  it("refuses malformed saved state and repairs partial state", () => {
    expect(() => normalize({ version: 2 })).toThrow();
    expect(() => normalize("nope")).toThrow();
    const c = normalize({ version: 1, speed: 1e9, jobs: "x", settings: { backfill: false } });
    expect(c.speed).toBeLessThanOrEqual(240);
    expect(c.jobs).toEqual([]);
    expect(c.settings.backfill).toBe(false);
    expect(c.settings.qos.student.maxGpusPerUser).toBe(1);
    expect(c.nodes.length).toBeGreaterThan(0);
  });

  it("runs an uploaded script through the same queue and email flow", () => {
    const c = createCluster(0);
    expect(() => addUpload(c, "asha", "notes.txt", "x")).toThrow(/\.py/);
    expect(() => addUpload(c, "asha", "big.py", "x".repeat(300 * 1024))).toThrow(/200 KB/);
    const id = addUpload(c, "asha", "C:\\work\\my train.py", "print('hi')\n");
    expect(id).toBe("upload:asha/my_train.py");
    submitJob(c, { ...base, workload: id, args: "", timeLimitMin: 15 });
    run(c, 700);
    expect(c.jobs[0].state).toBe("COMPLETED");
    expect(c.jobs[0].log.join("\n")).toContain("python jobs/uploads/asha/my_train.py");
    expect(c.emails[0].body).toContain("Your job is completed.");
    removeUpload(c, "asha", "my_train.py");
    expect(() => submitJob(c, { ...base, workload: id, args: "" })).toThrow(/no longer exists/);
  });

  it("lowers fair-share for heavy accounts", () => {
    expect(fairshareFactor("a", { a: 90, b: 10 }, { a: 50, b: 50 })).toBeLessThan(fairshareFactor("b", { a: 90, b: 10 }, { a: 50, b: 50 }));
  });
});
