import { useMemo, useRef, useState } from "react";
import { store, useCluster } from "../engine/store";
import { MAX_UPLOAD_BYTES, addUpload, removeUpload, submitJob, validate } from "../engine/engine";
import { submitDemoBatch } from "../engine/demo";
import { WORKLOADS, isUpload, uploadId, workloadById, parseArgs } from "../engine/workloads";
import { ROLES, ROLE_LABEL, partitions } from "../engine/config";
import { sbatchScript } from "../engine/queries";
import { fmtDuration } from "../engine/engine";
import { Badge, Card, Seg, Switch, ago, toast } from "../components/ui";
import { Icon } from "../components/icons";
import { useOpenJob } from "../components/cluster";
import type { JobRequest, Role } from "../engine/types";

const DEFAULT_EMAIL: Record<Role, string> = {
  student: "asha@students.example.edu",
  phd: "rahul@phd.example.edu",
  faculty: "prof_mehta@faculty.example.edu",
  startup: "neo_ai@incubator.example.edu",
};

export default function Submit() {
  const c = useCluster();
  const open = useOpenJob();
  const [r, setR] = useState<JobRequest>({
    name: "my-experiment",
    user: "asha",
    email: DEFAULT_EMAIL.student,
    role: "student",
    account: "teaching",
    partition: "gpu",
    cpus: 4,
    memGb: 16,
    gpus: 1,
    timeLimitMin: 15,
    workload: "train_model",
    args: workloadById("train_model").defaultArgs,
    mail: true,
  });
  const set = <K extends keyof JobRequest>(k: K, v: JobRequest[K]) => setR((x) => ({ ...x, [k]: v }));
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error("Scripts are limited to 200 KB in the web demo.");
      const text = await file.text();
      const id = store.act((c) => addUpload(c, r.user, file.name, text));
      setR((x) => ({ ...x, workload: id, args: "" }));
      toast(`Uploaded ${file.name}. It is selected as the workload below.`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const errors = useMemo(() => validate(c, r), [c, r]);
  const plan = workloadById(r.workload).plan(parseArgs(r.args));
  const qos = c.settings.qos[r.role];
  const willTimeout = plan.runtimeS > r.timeLimitMin * 60;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const id = store.act((c) => submitJob(c, r));
      toast(`Submitted batch job ${id}. It is in the queue.`);
      open(id);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Submit a job</h1>
          <p>This form does what `sbatch` does on a Slurm cluster. The job joins the queue, starts automatically when a node is free, and the owner gets an email when it ends.</p>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={() => {
              const ids = store.act(submitDemoBatch);
              toast(`Demo batch queued: jobs ${ids[0]}-${ids[ids.length - 1]}`);
            }}
          >
            <Icon name="zap" /> Submit demo batch (10 jobs)
          </button>
        </div>
      </div>

      <Card
        title="Upload your script"
        sub="a .py file; it becomes a workload you can submit"
        right={
          <>
            <button className="btn primary" type="button" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" /> Upload your script
            </button>
            <input ref={fileInput} type="file" accept=".py,text/x-python" hidden onChange={(e) => (void onUpload(e.target.files?.[0]), (e.target.value = ""))} />
          </>
        }
        flush
      >
        {c.uploads.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Script</th>
                  <th>Owner</th>
                  <th className="num">Lines</th>
                  <th className="num">Size</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {c.uploads.map((u) => {
                  const id = uploadId(u.user, u.name);
                  return (
                    <tr key={id}>
                      <td className="mono">
                        {u.name} {r.workload === id && <Badge value="selected" tone="t-ok" plain />}
                      </td>
                      <td>{u.user}</td>
                      <td className="num">{u.lines}</td>
                      <td className="num">{(u.size / 1024).toFixed(1)} KB</td>
                      <td className="small muted">{ago(c.now, u.time)}</td>
                      <td>
                        <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                          <button className="btn sm" onClick={() => setR((x) => ({ ...x, workload: id, args: "" }))}>
                            Use
                          </button>
                          <button className="btn sm ghost" onClick={() => setPreview(preview === id ? null : id)}>
                            {preview === id ? "Hide" : "View"}
                          </button>
                          <button
                            className="btn sm danger"
                            onClick={() => {
                              store.act((c) => removeUpload(c, u.user, u.name));
                              if (r.workload === id) setR((x) => ({ ...x, workload: "train_model", args: workloadById("train_model").defaultArgs }));
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {preview && (
              <pre className="code" style={{ margin: 12, maxHeight: 320 }}>
                {c.uploads.find((u) => uploadId(u.user, u.name) === preview)?.content ?? ""}
              </pre>
            )}
          </div>
        ) : (
          <div className="empty small">
            No scripts yet. Upload a <code>.py</code> file as user <b>{r.user || "…"}</b>, then submit it like any other job.
          </div>
        )}
        <div className="callout" style={{ margin: 12 }}>
          <Icon name="shield" />
          <div className="small">
            <b>Web demo:</b> your file stays in this browser and its run is <b>simulated</b>; the code is not executed. To run real code, use the local Python version
            (<code>uv run hpc up</code>), which accepts <code>.py</code> files and <code>.zip</code> projects, or copy it to a real cluster with <code>scp</code> /
            <code>rsync</code> and run <code>sbatch</code>.
          </div>
        </div>
      </Card>

      <div className="grid g-2-1">
        <form className="card" onSubmit={submit} noValidate>
          <header className="card-head">
            <h2>Job request</h2>
          </header>
          <div className="card-body stack" style={{ gap: 16 }}>
            <div className="form-grid">
              <div className="field span-2">
                <label htmlFor="f-name">Job name</label>
                <input id="f-name" type="text" value={r.name} maxLength={60} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="f-user">Username</label>
                <input id="f-user" type="text" value={r.user} maxLength={32} onChange={(e) => set("user", e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="f-acct">Account</label>
                <select id="f-acct" value={r.account} onChange={(e) => set("account", e.target.value)}>
                  {Object.keys(c.settings.shares).map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </div>
              <div className="field span-4">
                <label>Role</label>
                <Seg
                  label="Role"
                  options={ROLES}
                  value={r.role}
                  format={(x) => ROLE_LABEL[x]}
                  onChange={(role) => setR((x) => ({ ...x, role, email: x.email === DEFAULT_EMAIL[x.role] ? DEFAULT_EMAIL[role] : x.email, account: role === "startup" ? "startups" : role === "student" ? "teaching" : "research" }))}
                />
                <span className="hint">
                  {ROLE_LABEL[r.role]}: priority bonus {qos.priority}, up to {qos.maxGpusPerUser} GPU(s) and {qos.maxRunningJobs} running jobs at a time, {qos.maxTimeMin} min per job.
                </span>
              </div>
              <div className="field span-2">
                <label htmlFor="f-wl">Workload</label>
                <select
                  id="f-wl"
                  value={r.workload}
                  onChange={(e) => {
                    const w = workloadById(e.target.value);
                    if (isUpload(w.id)) return setR((x) => ({ ...x, workload: w.id, args: "" }));
                    setR((x) => ({ ...x, workload: w.id, args: w.defaultArgs, partition: w.partition, gpus: w.partition === "gpu" ? Math.max(1, Math.min(w.gpus, qos.maxGpusPerUser)) : 0, cpus: w.partition === "gpu" ? 4 * Math.max(1, w.gpus) : 16 }));
                  }}
                >
                  {c.uploads.length > 0 && (
                    <optgroup label="Your uploads">
                      {c.uploads.map((u) => (
                        <option key={uploadId(u.user, u.name)} value={uploadId(u.user, u.name)}>
                          {u.user}/{u.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Sample workloads">
                    {WORKLOADS.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <span className="hint">{workloadById(r.workload).description}</span>
              </div>
              <div className="field span-2">
                <label htmlFor="f-args">Arguments</label>
                <input id="f-args" type="text" className="mono" value={r.args} onChange={(e) => set("args", e.target.value)} />
                <span className="hint">
                  Estimated run time {fmtDuration(plan.runtimeS)}
                  {plan.failAtS !== null && " · crashes on purpose (--fail-at)"}
                </span>
              </div>
              <div className="field span-4">
                <label>Partition</label>
                <Seg label="Partition" options={partitions(c)} value={r.partition} onChange={(p) => setR((x) => ({ ...x, partition: p, gpus: p === "cpu" ? 0 : Math.max(1, x.gpus) }))} />
              </div>
              <div className="field">
                <label htmlFor="f-cpu">CPU cores</label>
                <input id="f-cpu" type="number" min={1} max={64} value={r.cpus} onChange={(e) => set("cpus", Number(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="f-mem">Memory (GB)</label>
                <input id="f-mem" type="number" min={1} max={512} value={r.memGb} onChange={(e) => set("memGb", Number(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="f-gpu">GPUs</label>
                <input id="f-gpu" type="number" min={0} max={8} value={r.gpus} onChange={(e) => set("gpus", Number(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="f-time">Time limit (min)</label>
                <input id="f-time" type="number" min={1} max={qos.maxTimeMin} value={r.timeLimitMin} onChange={(e) => set("timeLimitMin", Number(e.target.value))} />
              </div>
              <div className="field span-2">
                <label htmlFor="f-email">Email for notifications</label>
                <input id="f-email" type="email" value={r.email} onChange={(e) => set("email", e.target.value)} />
              </div>
              <div className="field span-2" style={{ justifyContent: "flex-end" }}>
                <Switch checked={r.mail} onChange={(v) => set("mail", v)} label='Email me when the job ends ("Your job is completed.")' />
              </div>
            </div>
            {errors.length > 0 && (
              <div className="callout bad">
                <Icon name="alert" />
                <div>{errors.join(" ")}</div>
              </div>
            )}
            {willTimeout && !errors.length && (
              <div className="callout warn">
                <Icon name="clock" />
                <div>The workload needs about {fmtDuration(plan.runtimeS)}, more than the {r.timeLimitMin}-minute limit. The scheduler will stop it at the limit (state TIMEOUT).</div>
              </div>
            )}
            <div className="row">
              <button className="btn primary" type="submit" disabled={errors.length > 0}>
                <Icon name="send" /> Submit job
              </button>
              <span className="muted small">Simulated time runs {c.speed}× faster than real time. Change it in the top bar.</span>
            </div>
          </div>
        </form>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Batch script" sub="what you would run on a real cluster">
            <pre className="code">{sbatchScript(r)}</pre>
          </Card>
          <Card title="What happens next" flush>
            <ol className="small" style={{ margin: 0, padding: "12px 16px 12px 34px", display: "grid", gap: 6 }}>
              <li>The job is stored with state <b>PENDING</b> (reason "Queued").</li>
              <li>Each scheduler pass ranks pending jobs by fair-share, waiting time and role.</li>
              <li>If a node has room, the job starts there with its own GPUs (<code>CUDA_VISIBLE_DEVICES</code>).</li>
              <li>Short jobs may jump ahead into gaps (backfill) without delaying the job at the front.</li>
              <li>At exit or at the time limit the job ends as COMPLETED, FAILED or TIMEOUT.</li>
              <li>The owner gets an email: "Your job is completed."</li>
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
