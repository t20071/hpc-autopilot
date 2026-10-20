# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

**HPC Autopilot**: automates an HPC administrator's job-description duties. A user (student, PhD scholar, faculty, startup) submits a job → it is queued → the scheduler starts it when a node is idle → it runs → the owner is emailed "Your job is completed." Health checks, backups, reports and the audit log run without manual steps, and everything shows on a dashboard.

There are two implementations:

| Part | Where | Notes |
|---|---|---|
| Web app (the one that is deployed) | `web/` | Vite + React 18 + TypeScript. The cluster is **simulated in the browser** (`web/src/engine/`) and saved to localStorage. Deployed on Vercel with Root Directory = `web`. |
| Serverless functions + sign-in | `web/api/`, `web/middleware.ts` | `assistant.ts` (Groq LLM, `GROQ_API_KEY`), `send-email.ts` (Resend, `ALLOWED_EMAIL_DOMAINS`). Same-origin checks and rate limits. |
| Python autopilot (optional, local) | `src/hpc_autopilot/`, `jobs/`, `cluster.toml` | Real subprocesses, SQLite (WAL) queue, SMTP or `.eml` outbox, `hpc` CLI. |
| Streamlit admin view (local only) | `dashboard/` | Reads the same SQLite database. Not deployed. |

`doc/` holds the interview study PDFs and slides. It is gitignored and is not part of the code.

## Commands

```bash
# web
cd web && npm install
npm run dev        # http://localhost:5173; also serves api/*.ts and reads ../.env
npm test           # vitest: engine, Markdown, middleware
npm run build      # tsc -b (src) + tsc -p api + vite build

# python (from the repo root)
uv sync
uv run pytest      # tests/
uv run hpc up      # scheduler + Streamlit on localhost
```

On Windows, Smart App Control blocks uv's managed Python. The `.venv` was created from Miniconda Python (`uv venv --python <path>`). If `uv run` is blocked, use `.venv/Scripts/python.exe -m ...`.

## Conventions

- **Engine logic:**
  - Keep it pure and testable: `web/src/engine/policy.ts` and `src/hpc_autopilot/policy.py` mirror each other (multifactor priority, QoS limits, best-fit placement, EASY backfill).
  - Add a test for every scheduling or validation change.
- **Web state** lives in one mutable `Cluster` object in `store.ts`:
  - Change it through `store.act(fn)`.
  - Components read it with `useCluster()`.
  - Anything loaded from storage or imported goes through `normalize()`.
- **Secrets:**
  - `.env` at the root holds `GROQ_API_KEY`. Never print it, never commit it, and never reference it from `web/src`.
- **UI:**
  - The palette is inspired by IIM Udaipur (green `#477133`, charcoal `#212934`, coral `#ff7a59`) on a dark HPC console theme.
  - Dark and light themes both use the CSS tokens in `styles.css`.
  - Keep the "not affiliated with IIM Udaipur" footer, and use no logos.
- **Copy:** use plain, simple English.

The files in `.claude/rules/` were written for a different, website-recreation project and do not apply here.
