import { useRef, useState } from "react";
import { store, useCluster } from "../engine/store";
import { backupNow, reportNow } from "../engine/engine";
import { toCsv } from "../engine/queries";
import { ROLES, ROLE_LABEL } from "../engine/config";
import { Badge, Card, Callout, Seg, Switch, ago, clockTime, download, toast } from "../components/ui";
import { EventFeed } from "../components/cluster";
import { Icon } from "../components/icons";
import type { AutomationKey, Cluster, Level, Qos, Role } from "../engine/types";

const AUTOMATIONS: [AutomationKey, string, string][] = [
  ["scheduler", "Scheduler", "Rank the queue and start jobs on free nodes every pass."],
  ["health", "Health checks", "Watch temperature, ECC errors and heartbeats; drain, requeue and resume."],
  ["notify", "Email notifications", 'Email owners when jobs end ("Your job is completed.") and alert the admin.'],
  ["maintenance", "Maintenance", "Back up the database, write utilisation reports, purge old output."],
  ["traffic", "Synthetic traffic", "Random users submit jobs every few minutes, so the cluster stays busy for demos."],
];

const LEVELS: ("all" | Level)[] = ["all", "info", "warning", "error"];

export default function Automation() {
  const c = useCluster();
  const s = c.settings;
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  const fileInput = useRef<HTMLInputElement>(null);
  const edit = (fn: (c: Cluster) => void) => store.act(fn);
  const pass = s.automations.scheduler ? "every pass (5 s simulated)" : "paused";

  const jd: [string, string, string, string][] = [
    ["Job scheduling and queue management", "Multifactor priority (fair-share + age + role), per-role limits, best-fit placement, EASY backfill", pass, ago(c.now, c.meta.lastHealth)],
    ["Run jobs and enforce limits", "Start on assigned GPUs (CUDA_VISIBLE_DEVICES), stop at the time limit, honour cancellations", pass, ago(c.now, c.meta.lastHealth)],
    ["User support: completion notices", "Email on COMPLETED / FAILED / TIMEOUT / CANCELLED with run summary and last log lines", s.automations.notify ? "on job end" : "paused", ago(c.now, c.emails.find((e) => e.kind === "user")?.time)],
    ["Monitor utilisation and GPU health", "Per-node temperature, allocation history, queue depth, wait times", s.automations.health ? "every pass" : "paused", ago(c.now, c.meta.lastHealth)],
    ["Troubleshoot hardware faults", "Auto-drain on overheating or ECC error; mark DOWN, requeue jobs, alert admin; auto-resume", s.automations.health ? "every pass" : "paused", ago(c.now, c.events.find((e) => e.category === "health")?.time)],
    ["Backups and disaster recovery", `Database snapshot, keep last 10`, `every ${s.backupEveryMin} min`, ago(c.now, c.backups[0]?.time)],
    ["Usage reporting for leadership", "Per-user and per-account GPU/CPU hours, success rate, average wait", `every ${s.reportEveryMin} min`, ago(c.now, c.reports[0]?.time)],
    ["Storage hygiene", `Purge job output older than ${s.purgeAfterDays} days`, "daily", c.events.some((e) => e.message.startsWith("Retention")) ? ago(c.now, c.meta.lastPurge) : "never"],
    ["Access control and audit", "Role-based limits, workload allow-list, validated input, audit log (demo: no sign-in; production uses SSO/LDAP)", "always", "-"],
  ];

  const setQos = (role: Role, key: keyof Qos, v: number) => edit((c) => void (c.settings.qos[role][key] = Math.max(0, v)));
  const events = level === "all" ? c.events : c.events.filter((e) => e.level === level);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automation centre</h1>
          <p>Every duty in the HPC administrator's job description, mapped to the automation that does it. The admin's job becomes watching this page and acting on alerts.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => (edit((c) => backupNow(c, true)), toast("Backup written"))}>
            <Icon name="db" /> Back up now
          </button>
          <button className="btn" onClick={() => (edit((c) => reportNow(c, true)), toast("Usage report written"))}>
            <Icon name="chart" /> Report now
          </button>
        </div>
      </div>

      <Card title="Job description → automation" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Duty</th>
                <th>How it is automated</th>
                <th>Runs</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {jd.map(([duty, how, runs, last]) => (
                <tr key={duty}>
                  <td style={{ fontWeight: 500 }}>{duty}</td>
                  <td className="small">{how}</td>
                  <td>
                    <Badge value={runs} tone={runs === "paused" ? "t-warn" : "t-ok"} plain />
                  </td>
                  <td className="mono small">{last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Automations">
          <div className="stack" style={{ gap: 14 }}>
            {AUTOMATIONS.map(([key, label, desc]) => (
              <div key={key} className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                <Switch checked={s.automations[key]} onChange={(v) => edit((c) => void (c.settings.automations[key] = v))} />
                <div>
                  <b>{label}</b>
                  <div className="small muted">{desc}</div>
                </div>
              </div>
            ))}
            <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
              <Switch checked={s.backfill} onChange={(v) => edit((c) => void (c.settings.backfill = v))} />
              <div>
                <b>Backfill</b>
                <div className="small muted">Let short jobs use idle gaps without delaying the job at the front of the queue.</div>
              </div>
            </div>
            <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
              <Switch checked={s.autoResume} onChange={(v) => edit((c) => void (c.settings.autoResume = v))} />
              <div>
                <b>Auto-resume healthy nodes</b>
                <div className="small muted">Bring a node drained by the health check back once it passes again.</div>
              </div>
            </div>
            <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
              <Switch checked={s.realEmail} onChange={(v) => edit((c) => void (c.settings.realEmail = v))} />
              <div>
                <b>Real email delivery</b>
                <div className="small muted">
                  Send through the <code>/api/send-email</code> serverless function (Resend). Needs <code>RESEND_API_KEY</code> and <code>ALLOWED_EMAIL_DOMAINS</code> set in Vercel; otherwise
                  emails stay in the outbox marked "failed".
                </div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="admin-email">Admin alert address</label>
              <input id="admin-email" type="email" value={s.adminEmail} onChange={(e) => edit((c) => void (c.settings.adminEmail = e.target.value))} />
            </div>
          </div>
        </Card>

        <Card title="Scheduling policy" sub="changes apply on the next pass">
          <div className="stack" style={{ gap: 14 }}>
            <div className="form-grid">
              {(["fairshare", "age", "qos"] as const).map((k) => (
                <div className="field" key={k}>
                  <label htmlFor={`w-${k}`}>Weight: {k === "qos" ? "role" : k}</label>
                  <input id={`w-${k}`} type="number" min={0} step={100} value={s.weights[k]} onChange={(e) => edit((c) => void (c.settings.weights[k] = Math.max(0, Number(e.target.value))))} />
                </div>
              ))}
              <div className="field">
                <label htmlFor="w-temp">GPU temp limit (°C)</label>
                <input id="w-temp" type="number" min={50} max={110} value={s.tempLimit} onChange={(e) => edit((c) => void (c.settings.tempLimit = Number(e.target.value)))} />
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th className="num">Priority</th>
                    <th className="num">Max GPUs</th>
                    <th className="num">Max jobs</th>
                    <th className="num">Max min</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLES.map((r) => (
                    <tr key={r}>
                      <td>{ROLE_LABEL[r]}</td>
                      {(["priority", "maxGpusPerUser", "maxRunningJobs", "maxTimeMin"] as const).map((k) => (
                        <td key={k} className="num">
                          <input type="number" min={0} value={s.qos[r][k]} onChange={(e) => setQos(r, k, Number(e.target.value))} style={{ width: 72, textAlign: "right" }} aria-label={`${ROLE_LABEL[r]} ${k}`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <span className="small muted">Account shares:</span>
              {Object.entries(s.shares).map(([a, v]) => (
                <label key={a} className="row small" style={{ gap: 6 }}>
                  {a}
                  <input type="number" min={1} value={v} style={{ width: 64 }} onChange={(e) => edit((c) => void (c.settings.shares[a] = Math.max(1, Number(e.target.value))))} />
                </label>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Backups" sub={`every ${s.backupEveryMin} min, last 10 kept`} flush>
          {c.backups.length ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th className="num">Jobs</th>
                  <th className="num">Events</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {c.backups.map((b) => (
                  <tr key={b.time}>
                    <td className="mono small">{clockTime(b.time)}</td>
                    <td className="num">{b.jobs}</td>
                    <td className="num">{b.events}</td>
                    <td className="num">{b.sizeKb} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">First scheduled backup after {s.backupEveryMin} simulated minutes, or press "Back up now".</div>
          )}
        </Card>
        <Card title="Utilisation reports" flush>
          {c.reports.length ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th className="num">Users</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {c.reports.map((r) => (
                  <tr key={r.time}>
                    <td className="mono small">{clockTime(r.time)}</td>
                    <td className="num">{r.rows.length}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn sm" onClick={() => download(`usage_${new Date(r.time * 1000).toISOString().slice(0, 16).replace(":", "")}.csv`, toCsv(r.rows))}>
                        <Icon name="download" size={14} /> CSV
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">First report after {s.reportEveryMin} simulated minutes, or press "Report now".</div>
          )}
        </Card>
      </div>

      <Card title="Audit log" sub={`${c.events.length} events`} flush right={<Seg label="Level" options={LEVELS} value={level} onChange={setLevel} />}>
        <div className="scroll">
          <EventFeed events={events} limit={200} />
        </div>
      </Card>

      <Card title="Cluster data">
        <div className="stack">
          <Callout icon="db">
            Everything runs in your browser and is saved in its local storage, so the cluster carries on where you left it. Export a copy, load one, or start again.
          </Callout>
          <div className="row">
            <button className="btn" onClick={() => download("hpc-autopilot-state.json", JSON.stringify(store.state, null, 1), "application/json")}>
              <Icon name="download" /> Export state (JSON)
            </button>
            <button className="btn" onClick={() => fileInput.current?.click()}>
              <Icon name="refresh" /> Import state
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // allow choosing the same file again
                if (!file) return;
                try {
                  if (file.size > 5_000_000) throw new Error("That file is too large to be a state export.");
                  store.replace(JSON.parse(await file.text()));
                  toast("State imported");
                } catch (err) {
                  toast(err instanceof SyntaxError ? "That file is not valid JSON." : (err as Error).message, true);
                }
              }}
            />
            <button className="btn" onClick={() => (store.reset(true), toast("Cluster reset with the demo batch"))}>
              <Icon name="refresh" /> Reset with demo jobs
            </button>
            <button className="btn danger" onClick={() => (store.reset(false), toast("Cluster reset (empty)"))}>
              <Icon name="trash" /> Reset empty
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}
