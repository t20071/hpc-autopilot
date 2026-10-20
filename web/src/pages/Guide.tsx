import { Card } from "../components/ui";
import { Icon, type IconName } from "../components/icons";

const STEPS: [IconName, string, string][] = [
  ["send", "Submit", "A student, PhD scholar, faculty member or startup submits a job from the web form, the console (sbatch) or an API, with an email address."],
  ["list", "Queue", "The job is stored as PENDING. Nothing else is needed from anyone."],
  ["zap", "Schedule", "Every pass the scheduler ranks pending jobs (fair-share + waiting time + role), applies per-role limits, and looks for an idle node."],
  ["cpu", "Run", "If a node has room, the job starts with its own GPUs. Short jobs backfill into gaps. The time limit is enforced."],
  ["mail", "Notify", 'When the job ends the owner is emailed: "Your job is completed." (or failed / timed out / cancelled) with a run summary.'],
  ["dashboard", "Observe", "The dashboard shows queue, nodes, GPU use, health, usage reports and an audit log of every automatic action."],
];

const SLURM: [string, string, string][] = [
  ["Submit and queue", "sbatch / slurmrestd REST API / Open OnDemand", "Submit form, console sbatch"],
  ["Priority and fairness", "priority/multifactor: PriorityWeightFairshare, PriorityWeightAge, PriorityWeightQOS", "Automation → Scheduling policy"],
  ["Per-role limits", "sacctmgr QOS: MaxTRESPerUser=gres/gpu=N, MaxJobsPerUser, MaxWall", "Role table"],
  ["Backfill", "SchedulerType=sched/backfill", "Backfill switch"],
  ['"Your job is completed." email', "#SBATCH --mail-type=END,FAIL --mail-user=…, MailProg in slurm.conf (or a Jobcomp/Epilog script)", "Notifications"],
  ["Health checks, auto-drain", "HealthCheckProgram=/usr/sbin/nhc, HealthCheckInterval=300; DCGM / rocm-smi for GPUs", "Nodes → Failure drills"],
  ["Requeue on node failure", "JobRequeue=1, ReturnToService=2", "Node failure drill"],
  ["Monitoring dashboard", "Prometheus + slurm-exporter + DCGM exporter, Grafana; alerts via Alertmanager", "Overview"],
  ["Usage reports", "sreport cluster AccountUtilizationByUser, sshare", "Accounting"],
  ["Backups and housekeeping", "cron or systemd timers: mysqldump slurm_acct_db, find -mtime +7 -delete", "Automation → Backups"],
  ["Provisioning and patching", "Ansible / Warewulf / xCAT; drain → patch → resume playbook", "Nodes → Planned maintenance"],
];

export default function Guide() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>How it works</h1>
          <p>The end-to-end workflow, what you need to run it, and how each piece maps to a real Slurm cluster.</p>
        </div>
      </div>

      <Card title="Workflow: submit to email with no manual steps">
        <ol className="stack" style={{ margin: 0, padding: 0, listStyle: "none", gap: 12 }}>
          {STEPS.map(([icon, title, text], i) => (
            <li key={title} className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start", gap: 14 }}>
              <div className="stage" style={{ padding: 0 }}>
                <div className="dot" style={{ margin: 0 }}>
                  <Icon name={icon} size={18} />
                </div>
              </div>
              <div>
                <b>
                  {i + 1}. {title}
                </b>
                <div className="muted">{text}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid g2">
        <Card title="Requirements">
          <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
            <li>
              <b>This web app:</b> any modern browser. Deploys as a static site on Vercel (free tier is fine). No HPC account and no server needed: the cluster is
              simulated in the browser and saved locally.
            </li>
            <li>
              <b>Real email (optional):</b> a Resend API key plus <code>ALLOWED_EMAIL_DOMAINS</code>, set as Vercel environment variables.
            </li>
            <li>
              <b>Python version (optional, same repository):</b> Python 3.12+, uv. It runs real processes on your PC with a SQLite queue, SMTP or .eml outbox, and a
              Streamlit admin view.
            </li>
            <li>
              <b>On a real cluster:</b> Slurm 23+ with slurmdbd, NVIDIA DCGM or AMD ROCm SMI, NHC, Prometheus and Grafana, an SMTP relay, and Ansible for configuration.
            </li>
          </ul>
        </Card>
        <Card title="Glossary">
          <dl className="kv" style={{ gridTemplateColumns: "120px 1fr" }}>
            <dt>Partition</dt>
            <dd style={{ fontFamily: "var(--sans)" }}>A group of nodes (here: gpu and cpu).</dd>
            <dt>Fair-share</dt>
            <dd style={{ fontFamily: "var(--sans)" }}>2^(−usage/share): accounts that used less than their share go first.</dd>
            <dt>QoS</dt>
            <dd style={{ fontFamily: "var(--sans)" }}>Per-role priority bonus and limits on GPUs, jobs and time.</dd>
            <dt>Backfill</dt>
            <dd style={{ fontFamily: "var(--sans)" }}>Starting a short job early when it ends before the top job's reserved start.</dd>
            <dt>Drain</dt>
            <dd style={{ fontFamily: "var(--sans)" }}>Running jobs finish; no new jobs start on the node.</dd>
            <dt>Requeue</dt>
            <dd style={{ fontFamily: "var(--sans)" }}>A job from a failed node goes back into the queue and restarts elsewhere.</dd>
          </dl>
        </Card>
      </div>

      <Card title="On a real Slurm cluster" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Requirement</th>
                <th>Production building block</th>
                <th>Where it is in this app</th>
              </tr>
            </thead>
            <tbody>
              {SLURM.map(([a, b, c]) => (
                <tr key={a}>
                  <td style={{ fontWeight: 500 }}>{a}</td>
                  <td className="mono small">{b}</td>
                  <td className="small">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="slurm.conf excerpt">
          <pre className="code">{`SchedulerType=sched/backfill
PriorityType=priority/multifactor
PriorityDecayHalfLife=1-0
PriorityWeightFairshare=10000
PriorityWeightAge=1000
PriorityWeightQOS=2000
PriorityMaxAge=00:10:00
AccountingStorageTRES=gres/gpu
TRESBillingWeights="CPU=1.0,GRES/gpu=16.0"
MailProg=/usr/bin/smail
HealthCheckProgram=/usr/sbin/nhc
HealthCheckInterval=300
JobRequeue=1
ReturnToService=2`}</pre>
        </Card>
        <Card title="Deploy this app">
          <pre className="code">{`# 1. push to GitHub
git init && git add . && git commit -m "HPC Autopilot"
git remote add origin https://github.com/<you>/hpc-autopilot.git
git push -u origin main

# 2. vercel.com > Add New > Project > import the repo
#    Root Directory: web     (Vite is detected)
#    Deploy

# 3. optional real email: Settings > Environment Variables
#    RESEND_API_KEY, MAIL_FROM, ALLOWED_EMAIL_DOMAINS`}</pre>
        </Card>
      </div>
    </>
  );
}
