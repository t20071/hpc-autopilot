// Browser runtime: advances the simulated cluster once a second, saves it to localStorage,
// and hands queued emails to the optional /api/send-email function.
import { useSyncExternalStore } from "react";
import { createCluster, defaultSettings } from "./config";
import { logEvent, snapshot, step } from "./engine";
import { randomJob, submitDemoBatch } from "./demo";
import type { Cluster } from "./types";

const KEY = "hpc-autopilot/v1";
const LOCK = "hpc-autopilot-simulation";
const SUBSTEP = 5; // simulated seconds per engine pass
export const MAX_SPEED = 240;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accept a saved or imported state only if it has the right shape; fill gaps from defaults. */
export function normalize(input: unknown): Cluster {
  if (!isObj(input) || input.version !== 1) throw new Error("Not an HPC Autopilot state file (version 1).");
  const base = createCluster();
  const d = defaultSettings();
  const s = isObj(input.settings) ? input.settings : {};
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  const c: Cluster = {
    ...base,
    ...input,
    now: Number.isFinite(input.now) ? (input.now as number) : base.now,
    speed: Math.min(MAX_SPEED, Math.max(1, Number(input.speed) || 20)),
    paused: Boolean(input.paused),
    nextId: { ...base.nextId, ...(isObj(input.nextId) ? input.nextId : {}) },
    jobs: arr<Cluster["jobs"][number]>(input.jobs).filter((j) => isObj(j) && Number.isFinite(j.id) && typeof j.state === "string"),
    nodes: arr<Cluster["nodes"][number]>(input.nodes).filter((n) => isObj(n) && typeof n.name === "string" && Number.isInteger(n.cpus) && n.cpus > 0),
    // an email whose delivery was cut off by closing the page is not resent (it may have gone out)
    emails: arr<Cluster["emails"][number]>(input.emails).map((e) => (e.delivery === "sending" ? { ...e, delivery: "failed" } : e)),
    events: arr(input.events),
    snapshots: arr(input.snapshots),
    backups: arr(input.backups),
    reports: arr(input.reports),
    uploads: arr<Cluster["uploads"][number]>(input.uploads).filter((u) => isObj(u) && typeof u.name === "string" && typeof u.content === "string"),
    meta: { ...base.meta, ...(isObj(input.meta) ? input.meta : {}) },
    settings: {
      ...d,
      ...s,
      weights: { ...d.weights, ...(isObj(s.weights) ? s.weights : {}) },
      qos: { ...d.qos, ...(isObj(s.qos) ? s.qos : {}) } as Cluster["settings"]["qos"],
      shares: isObj(s.shares) && Object.keys(s.shares).length ? (s.shares as Record<string, number>) : d.shares,
      automations: { ...d.automations, ...(isObj(s.automations) ? s.automations : {}) },
    },
  };
  if (!c.nodes.length) c.nodes = base.nodes;
  return c;
}

function load(): Cluster {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  const c = createCluster();
  logEvent(c, "info", "system", "Cluster created. Autopilot is on: scheduling, health checks, email and maintenance run automatically.");
  submitDemoBatch(c);
  return c;
}

class Store {
  state: Cluster = load();
  private version = 0;
  private listeners = new Set<() => void>();
  private timer: number | undefined;
  private ticks = 0;
  private delivering = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  /** Only one tab runs the cluster ("leader"); other tabs are live, read-only views ("follower"). */
  role: "starting" | "leader" | "follower" = "starting";
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener("pagehide", () => this.role === "leader" && this.save());
    window.addEventListener("storage", (e) => {
      if (this.role !== "follower" || e.key !== KEY || !e.newValue) return;
      try {
        this.state = normalize(JSON.parse(e.newValue));
        this.emit();
      } catch {
        /* ignore a half-written value */
      }
    });
    if (!navigator.locks) return this.lead();
    this.requestLock(false);
  }

  /** Move the simulation into this tab; the tab that was running it becomes read-only. */
  takeOver() {
    this.requestLock(true);
  }

  private requestLock(steal: boolean) {
    navigator.locks
      .request(LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) return this.follow();
        this.lead();
        return new Promise<void>(() => {}); // hold the lock until this tab closes or another takes over
      })
      .catch(() => this.follow()); // AbortError: another tab took over
  }

  private lead() {
    try {
      const raw = localStorage.getItem(KEY); // continue from whatever the previous tab saved
      if (raw) this.state = normalize(JSON.parse(raw));
    } catch {
      /* keep the in-memory state */
    }
    this.role = "leader";
    if (this.timer === undefined) this.timer = window.setInterval(() => this.tick(), 1000);
    this.emit();
  }

  private follow() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.role = "follower";
    this.emit();
  }

  private emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* quota or private mode: keep running in memory */
    }
  }

  tick() {
    const c = this.state;
    if (!c.paused) {
      let remaining = c.speed;
      while (remaining > 0) {
        const dt = Math.min(SUBSTEP, remaining);
        step(c, dt, randomJob);
        remaining -= dt;
      }
      snapshot(c);
      void this.deliver();
    }
    if (++this.ticks % 3 === 0) this.save();
    this.emit();
  }

  /** Run an action against the cluster, then re-render and persist. */
  private assertLeader() {
    if (this.role === "follower") throw new Error('This tab is read-only. Click "Run it here" to control the cluster from this tab.');
  }

  act<T>(fn: (c: Cluster) => T): T {
    this.assertLeader();
    const out = fn(this.state);
    this.emit();
    this.save();
    return out;
  }

  reset(seedDemo = true) {
    this.assertLeader();
    const c = createCluster();
    logEvent(c, "info", "system", "Cluster reset by admin.");
    if (seedDemo) submitDemoBatch(c);
    this.state = c;
    this.emit();
    this.save();
  }

  /** Load an exported state file. Throws if it is not a valid one. */
  replace(input: unknown) {
    this.assertLeader();
    this.state = normalize(input);
    this.emit();
    this.save();
  }

  private async deliver() {
    if (this.delivering) return; // one delivery run at a time, so nothing is sent twice
    const queued = this.state.emails.filter((e) => e.delivery === "queued");
    if (!queued.length) return;
    if (!this.state.settings.realEmail) {
      queued.forEach((e) => (e.delivery = "outbox"));
      return;
    }
    this.delivering = true;
    queued.forEach((e) => (e.delivery = "sending"));
    for (const e of queued) {
      try {
        const res = await fetch("/api/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: e.to, subject: e.subject, text: e.body }),
        });
        if (!res.ok) throw new Error(await res.text());
        e.delivery = "sent";
      } catch (err) {
        e.delivery = "failed";
        logEvent(this.state, "warning", "email", `Real delivery to ${e.to} failed (${String(err).slice(0, 120)}); kept in the outbox`);
      }
    }
    this.delivering = false;
  }
}

export const store = new Store();

export function useCluster(): Cluster {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.state;
}
