# HPC Autopilot

A self-running GPU cluster control centre. When a student, PhD scholar, faculty member or startup submits a job, it is **queued, scheduled onto an idle node, executed, and the owner is emailed "Your job is completed."** No one has to step in. Every admin duty runs automatically and shows on one dashboard.

You do not need an HPC account. The web app simulates a 4-node cluster (2× NVIDIA H100 nodes, 1× AMD MI300X node and 1 CPU node) in the browser.

## Workflow

```
submit ──► queue (PENDING) ──► scheduler pass ──► idle node? ──yes──► run (RUNNING) ──► COMPLETED / FAILED / TIMEOUT ──► email owner
                 ▲                  │ no                                  │
                 │                  └── wait, with a reason: Resources / Priority / QOS limit
                 └──── requeue if the node fails ◄── health check ◄───────┘
```

Every pass (5 simulated seconds) runs these steps in order:

1. **Health check.** Reads GPU temperature, ECC errors and node heartbeat. A faulty node is drained, a dead node is marked down and its jobs are requeued, the admin gets an email, and the node resumes automatically once it is healthy again.
2. **Accounting.** Marks jobs that finished, failed or hit their time limit.
3. **Scheduling.**
   - Priority = fair-share + waiting time + role.
   - Per-role limits cap GPUs, running jobs and minutes per job.
   - Jobs go to the best-fitting node.
   - EASY backfill lets short jobs run early when they don't delay the job at the front of the queue.
4. **Notify.** Emails the job owner, and the admin when there is an alert.
5. **Maintenance.** Database backup, utilisation report and purge of old job output.

## What the web app does

| Page | What it does |
|---|---|
| Overview | KPIs with trends, the submit → email pipeline, allocation charts, a live rack view with one tile per GPU, and an autopilot activity feed |
| Submit job | **Upload your script** (`.py`), then an `sbatch`-style form with role limits, a preview of the equivalent Slurm script, and a 10-job demo batch. In the web demo an uploaded script's run is simulated |
| Queue | Like `squeue`: wait reasons, priority breakdown, output log, cancel, CSV export |
| Nodes & health | Like `sinfo`: drain/resume, failure drills (overheating, ECC error, node down), add or remove nodes |
| Accounting | Like `sshare`/`sreport`: fair-share per account, GPU and CPU hours per user, job outcomes, CSV |
| Notifications | Inbox of every user notice and admin alert |
| Automation | Job-description duties mapped to the automation that does each one, on/off switches, editable policy, backups and reports, audit log, export/import/reset |
| AI assistant | Ask about the live cluster in plain English (Groq LLM; a built-in summary is used if no key is set) |
| Console | Slurm-style commands: `sbatch`, `squeue`, `sinfo`, `scancel`, `scontrol`, `sacct`, `sshare`, `sprio` |
| How it works | The workflow, the requirements, and how each part maps to real Slurm |

## Requirements

- **Web app:** Node.js 20+ and npm. It runs on Vercel's free tier, with no server or database.
- **Optional AI assistant:** a `GROQ_API_KEY`.
- **Optional real email:** a [Resend](https://resend.com) API key and `ALLOWED_EMAIL_DOMAINS`.
- **Optional Python version** (real processes on your PC, a SQLite queue, SMTP or a `.eml` outbox, and a Streamlit admin view): Python 3.12+ and [uv](https://docs.astral.sh/uv/).

## Run locally

```bash
cd web
npm install
npm run dev      # http://localhost:5173 ; reads GROQ_API_KEY from ../.env
npm test         # 16 tests: engine, uploads, Markdown rendering, sign-in middleware
```

## Deploy on Vercel

1. Push the repository to GitHub. `.gitignore` keeps `.env`, `node_modules`, `.venv` and `doc/` out of the repo.
2. On vercel.com, go to **Add New → Project**, import the repository, set **Root Directory = `web`**, and deploy. Vite is detected automatically.
3. Optional: under **Settings → Environment Variables**, add the variables below, then redeploy.

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | AI assistant (`/api/assistant`). Optional `GROQ_MODEL`; the default is `openai/gpt-oss-120b`. |
| `RESEND_API_KEY`, `MAIL_FROM`, `ALLOWED_EMAIL_DOMAINS` | Real email (`/api/send-email`). Turn it on with **Automation → Real email delivery**. |
| `DASHBOARD_PASSWORD` (optional `DASHBOARD_USER`, default `admin`) | Puts a sign-in prompt in front of the whole site and its API (`middleware.ts`). Recommended whenever `GROQ_API_KEY` or `RESEND_API_KEY` is set. |

Simulation state is saved in each visitor's browser. The cluster advances only while the page is open; use the speed buttons in the top bar to go faster. If you open the app in several tabs, one tab runs the cluster and the others show it live as read-only views, so they never overwrite each other. Click **Run it here** to move control to the current tab.

## Optional: Python autopilot (real processes)

```bash
uv sync
uv run hpc up                    # scheduler + Streamlit dashboard (http://localhost:8501)
uv run hpc demo                  # submit the 10-job demo batch
uv run hpc submit "python jobs/train_model.py --epochs 3" --name train-demo \
    --user asha --email asha@students.example.edu --role student --account teaching --gpus 1 --time 10
uv run hpc queue                 # like squeue      (also: nodes, cancel, drain, resume, fault, report, backup)
uv run hpc scheduler             # scheduler only   (--until-idle exits when the queue is empty)
uv run hpc dashboard             # dashboard only
uv run pytest                    # 34 tests: policy, validation, end-to-end, restart, locking, mailer, uploads
```

- **Settings** live in `cluster.toml`: nodes, roles (QoS), accounts, registered users, email, health limits and maintenance timers. Restart the scheduler after you edit it.
- **Your own code:** on the dashboard's Submit page, use **Upload your script**.
  - Upload a `.py` file or a `.zip` project (up to 50 MB). Files are saved in `jobs/uploads/<user>/`, and it appears in the Workload list.
  - Projects run from their own folder, so relative paths such as `data/train.csv` work. Write outputs to `$HPC_JOB_DIR`.
  - Unsafe zip paths (`..`, absolute paths, symlinks) are refused.
  - Uploaded code runs with this project's Python environment. Add any packages it needs with `uv add <package>`.
  - You can also just copy a script into `jobs/` and submit `python jobs/<script>.py`.
- **Registered users:** `[users.<name>]` fixes each user's role and account, so nobody can claim a higher role. `require_known_users = true` blocks unknown users entirely.
- **Email:** by default messages are written to `outbox/*.eml`. Set `[email] mode = "smtp"` to send real email. The SMTP password comes from the `HPC_SMTP_PASSWORD` environment variable, not from `.env`. Login is allowed only over STARTTLS with a verified certificate. A background mailer thread delivers SMTP mail, so a slow or broken mail server never holds up scheduling. Failed sends are retried 5 times with increasing waits, then reported in the audit log.
- **One scheduler at a time:** a lock file prevents a second scheduler from starting. After a crash, the next start stops the job processes left behind and requeues their jobs.
- **Windows:** if Smart App Control is on, create the venv from a Python it already trusts: `uv venv --python <path-to-python.exe>`.

## Moving to a real Slurm cluster

| Duty | Production building block |
|---|---|
| Queue and schedule | `sbatch`, `slurmrestd`; `priority/multifactor` and `sched/backfill`; QOS limits via `sacctmgr` |
| "Your job is completed." | `#SBATCH --mail-type=END,FAIL --mail-user=…` and `MailProg` |
| Health, drain, requeue | `HealthCheckProgram=/usr/sbin/nhc`, DCGM or ROCm SMI, `JobRequeue=1`, `ReturnToService=2` |
| Dashboard and alerts | Prometheus, slurm-exporter and DCGM exporter feeding Grafana and Alertmanager |
| Reports, backups, patching | `sreport`; cron or systemd timers with `mysqldump`; Ansible drain → patch → resume |

## Security notes

- **Keys stay on the server:** API keys live only in the Vercel functions and are never sent to the browser.
- **Both API functions:**
  - accept only same-site requests (checked with the `Origin` and `Sec-Fetch-Site` headers);
  - rate-limit each IP address;
  - cap the size of what they accept;
  - return clean errors instead of crashing.
- **`/api/send-email` limits:** it sends only plain addresses on `ALLOWED_EMAIL_DOMAINS`, and only with HPC Autopilot subjects.
- **Sign-in:** set `DASHBOARD_PASSWORD` and the whole site, including `/api/*`, asks for a password. Only signed-in admins can then use your Groq or Resend keys. For a production rollout, use your institute's SSO instead.
- **Rate limits:** the per-IP limits live in memory on each running function instance and are best-effort. For a hard cap, also add a **Vercel Firewall rate-limit rule** on `/api/*`.
- **Browser hardening:** `vercel.json` sets a Content-Security-Policy and other security headers.
- **Imported state files are checked:** they are validated and repaired before they are loaded. If saved data is ever corrupt, an error screen offers a one-click reset.
- **Python dashboard:** it binds to `localhost` only, runs only the scripts in `jobs/`, and launches them without a shell, so command injection is not possible.

This is an independent demonstration, not affiliated with or endorsed by IIM Udaipur. The colour palette is inspired by its website; no logos are used.
