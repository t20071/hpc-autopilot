import { createContext, useContext, useEffect, useRef } from "react";
import { Badge, Bar, StateBadge, clockTime, toast } from "./ui";
import { Icon, type IconName } from "./icons";
import { store, useCluster } from "../engine/store";
import { cancelJob, fmtDuration, fmtTime } from "../engine/engine";
import { nodeView, sbatchScript } from "../engine/queries";
import { isUpload, uploadId } from "../engine/workloads";
import { REASON_HELP } from "../engine/policy";
import { ROLE_LABEL } from "../engine/config";
import type { Job, LogEvent } from "../engine/types";
import { TERMINAL } from "../engine/types";

export const JobContext = createContext<(id: number | null) => void>(() => {});
export const useOpenJob = () => useContext(JobContext);

const PALETTE = ["#6fae52", "#ff7a59", "#4cc2ff", "#c792ea", "#f2b84b", "#5ad1b8", "#ef7fb0", "#9aa7ff"];
export const jobColor = (id: number) => PALETTE[id % PALETTE.length];

export function NodeRacks({ compact }: { compact?: boolean }) {
  const c = useCluster();
  const open = useOpenJob();
  return (
    <div className="racks">
      {nodeView(c).map(({ node: n, jobs, usedCpus, usedMem, status, gpuOwner }) => (
        <article key={n.name} className={`rack ${n.state}`} aria-label={`Node ${n.name}, ${status}`}>
          <div className="rack-head">
            <Icon name={n.gpus ? "gpu" : "cpu"} />
            <div>
              <div className="rack-name">{n.name}</div>
              <div className="rack-type">
                {n.partition} · {n.gpus ? `${n.gpus}× ${n.gpuType}` : `${n.cpus} cores`} · {n.memGb} GB
              </div>
            </div>
            <span style={{ marginLeft: "auto" }}>
              <Badge value={status} />
            </span>
          </div>
          {n.gpus > 0 && (
            <div className="gpus">
              {gpuOwner.map((j, i) => (
                <button
                  key={i}
                  type="button"
                  className={`gpu ${j ? "busy" : ""}`}
                  style={j ? { background: jobColor(j.id) } : undefined}
                  onClick={() => j && open(j.id)}
                  title={j ? `GPU ${i}: job ${j.id} ${j.name} (${j.user})` : `GPU ${i}: idle`}
                >
                  <b>GPU{i}</b>
                  <span>{j ? `#${j.id}` : "idle"}</span>
                </button>
              ))}
            </div>
          )}
          <div className="cores" aria-label={`${usedCpus} of ${n.cpus} CPU cores in use`}>
            {Array.from({ length: Math.min(64, n.cpus) }, (_, i) => (
              <span key={i} className={`core ${i < usedCpus ? "on" : ""}`} />
            ))}
          </div>
          {!compact && (
            <div className="small muted mono">
              CPU {usedCpus}/{n.cpus} · MEM {usedMem}/{n.memGb} GB · {jobs.length} job{jobs.length === 1 ? "" : "s"}
            </div>
          )}
          <div className="temp">
            <Icon name="thermo" size={14} />
            <Bar value={(n.temp - 20) / 80} tone={n.temp > c.settings.tempLimit ? "var(--danger)" : n.temp > 70 ? "var(--warn)" : "var(--primary)"} />
            <span>{n.temp.toFixed(0)}°C</span>
          </div>
          {(n.reason || n.fault) && (
            <div className="rack-reason">
              {n.reason || "Fault injected"}
              {n.fault && ` · fault: ${n.fault}`}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

const CATEGORY_ICON: Record<string, IconName> = {
  submit: "send",
  schedule: "zap",
  job: "cpu",
  email: "mail",
  health: "thermo",
  maintenance: "db",
  cancel: "x",
  requeue: "refresh",
  admin: "wrench",
  drill: "alert",
  system: "bot",
};

export function EventFeed({ events, limit = 12 }: { events: LogEvent[]; limit?: number }) {
  if (!events.length) return <div className="empty">No events yet.</div>;
  return (
    <ul className="feed">
      {events.slice(0, limit).map((e) => (
        <li key={e.id} className={`lvl-${e.level}`}>
          <span className="feed-icon">
            <Icon name={e.level === "error" ? "alert" : CATEGORY_ICON[e.category] ?? "bot"} size={14} />
          </span>
          <div className="feed-body">
            <div className="feed-msg">{e.message}</div>
            <div className="feed-meta">
              <span className="cat">{e.category}</span>
              <time>{clockTime(e.time)}</time>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function JobTable({ jobs, now, empty = "No jobs." }: { jobs: Job[]; now: number; empty?: string }) {
  const open = useOpenJob();
  if (!jobs.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap scroll">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Name</th>
            <th>User</th>
            <th>State</th>
            <th>Reason</th>
            <th className="num">Priority</th>
            <th>Node</th>
            <th className="num">GPU</th>
            <th>Time used</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const used = j.startTime !== undefined ? ((j.endTime ?? now) - j.startTime) / (j.timeLimitMin * 60) : 0;
            return (
              <tr key={j.id} className="clickable" onClick={() => open(j.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(j.id)}>
                <td className="mono">{j.id}</td>
                <td>{j.name}</td>
                <td>
                  {j.user} <span className="muted small">· {j.role}</span>
                </td>
                <td>
                  <StateBadge state={j.state} />
                </td>
                <td className="small" title={REASON_HELP[j.reason] ?? ""}>
                  {j.reason || <span className="muted">-</span>}
                </td>
                <td className="num">{j.state === "PENDING" ? j.priority.toLocaleString("en-US") : "-"}</td>
                <td className="mono">{j.node ?? "-"}</td>
                <td className="num">{j.gpus}</td>
                <td style={{ minWidth: 110 }}>{j.startTime !== undefined ? <Bar value={used} tone={used > 0.9 ? "var(--warn)" : "var(--info)"} /> : <span className="muted small">waiting</span>}</td>
                <td className="mono small">{clockTime(j.submitTime)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function JobDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const c = useCluster();
  const job = c.jobs.find((j) => j.id === id);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panel.current) return;
      // keep keyboard focus inside the dialog
      const items = panel.current.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  if (!job) {
    return (
      <>
        <div className="scrim" onClick={onClose} />
        <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Job ${id}`} ref={panel}>
          <div className="drawer-head">
            <h1 style={{ fontSize: 20 }}>Job {id}</h1>
            <button className="btn ghost sm" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto" }}>
              <Icon name="x" />
            </button>
          </div>
          <div className="drawer-body">
            <p className="muted">This job is no longer kept. Finished jobs are trimmed after a while to keep the dashboard fast; its email is still in Notifications.</p>
          </div>
        </aside>
      </>
    );
  }
  const ended = TERMINAL.includes(job.state);
  const bad = job.state === "FAILED" || job.state === "TIMEOUT" || job.state === "CANCELLED";
  const f = job.factors;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Job ${job.id}`} ref={panel}>
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="row">
              <span className="mono muted">Job {job.id}</span>
              <StateBadge state={job.state} />
              {job.backfilled && <Badge value="backfilled" tone="t-info" plain />}
              {job.attempt > 1 && <Badge value={`attempt ${job.attempt}`} tone="t-warn" plain />}
            </div>
            <h1 style={{ fontSize: 20, marginTop: 4 }}>{job.name}</h1>
            <div className="muted small">
              {job.user} · {ROLE_LABEL[job.role]} · account {job.account} · {job.email}
            </div>
          </div>
          <div className="row" style={{ marginLeft: "auto", flexWrap: "nowrap" }}>
            {!ended && (
              <button
                className="btn danger sm"
                onClick={() => {
                  try {
                    toast(store.act((c) => cancelJob(c, job.id)));
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                <Icon name="x" size={14} /> Cancel
              </button>
            )}
            <button className="btn ghost sm" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="drawer-body">
          <div className="timeline">
            <div className="done">
              Submitted<time>{clockTime(job.submitTime)}</time>
            </div>
            <div className={job.startTime !== undefined ? "done" : ""}>
              Scheduled{job.startTime !== undefined && <time>{clockTime(job.startTime)}</time>}
            </div>
            <div className={job.state === "RUNNING" || ended ? (bad && job.startTime === undefined ? "bad" : "done") : ""}>
              Running{job.node && <time>{job.node}</time>}
            </div>
            <div className={ended ? (bad ? "bad" : "done") : ""}>
              {ended ? job.state.toLowerCase() : "Finish"}
              {job.endTime !== undefined && <time>{clockTime(job.endTime)}</time>}
            </div>
            <div className={job.notified && job.mail ? "done" : ""}>
              Emailed<time>{job.mail ? (job.notified ? "sent" : "on finish") : "off"}</time>
            </div>
          </div>

          {job.state === "PENDING" && (
            <div className="callout warn">
              <Icon name="clock" />
              <div>
                <b>Waiting: {job.reason}.</b> {REASON_HELP[job.reason] ?? ""}
              </div>
            </div>
          )}

          <dl className="kv">
            <dt>Resources</dt>
            <dd>
              {job.partition} · {job.cpus} CPU · {job.memGb} GB · {job.gpus} GPU
            </dd>
            <dt>Time limit</dt>
            <dd>{job.timeLimitMin} min</dd>
            <dt>Node / GPUs</dt>
            <dd>
              {job.node ?? "-"}
              {job.gpuIds?.length ? ` · CUDA_VISIBLE_DEVICES=${job.gpuIds.join(",")}` : ""}
            </dd>
            <dt>Queue wait</dt>
            <dd>{fmtDuration((job.startTime ?? c.now) - job.submitTime)}</dd>
            <dt>Run time</dt>
            <dd>{job.startTime !== undefined ? fmtDuration((job.endTime ?? c.now) - job.startTime) : "-"}</dd>
            <dt>Exit code</dt>
            <dd>{job.exitCode ?? "-"}</dd>
            <dt>Finished</dt>
            <dd>{fmtTime(job.endTime)}</dd>
          </dl>

          {f && job.state === "PENDING" && (
            <div>
              <h3 style={{ marginBottom: 8 }}>Priority {Math.round(f.total).toLocaleString("en-US")}</h3>
              {(
                [
                  ["Fair-share", f.fairshare, c.settings.weights.fairshare, "var(--primary)"],
                  ["Age", f.age, c.settings.weights.age, "var(--info)"],
                  ["Role (QoS)", f.qos, c.settings.weights.qos, "var(--accent)"],
                ] as const
              ).map(([name, v, w, tone]) => (
                <div className="hbar" key={name}>
                  <span>{name}</span>
                  <Bar value={w ? v / w : 0} tone={tone} />
                  <span className="mono small" style={{ textAlign: "right" }}>
                    {Math.round(v)}/{w}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div>
            <h3 style={{ marginBottom: 8 }}>Output log</h3>
            <pre className="code" style={{ maxHeight: 260 }}>
              {job.log.length ? job.log.join("\n") : "(no output yet: the job has not started)"}
            </pre>
          </div>
          {isUpload(job.workload) && (
            <div>
              <h3 style={{ marginBottom: 8 }}>Your script (run simulated in the web demo)</h3>
              <pre className="code" style={{ maxHeight: 240 }}>
                {c.uploads.find((u) => uploadId(u.user, u.name) === job.workload)?.content ?? "(the uploaded file has since been deleted)"}
              </pre>
            </div>
          )}
          <div>
            <h3 style={{ marginBottom: 8 }}>Equivalent Slurm batch script</h3>
            <pre className="code">{sbatchScript(job)}</pre>
          </div>
        </div>
      </aside>
    </>
  );
}
