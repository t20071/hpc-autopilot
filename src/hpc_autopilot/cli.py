"""Command-line interface. Commands mirror Slurm where they can (sbatch, squeue, sinfo, scancel)."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time

from . import admin, demo, jobs, maintenance, queries
from .config import Settings, load_settings
from .db import init_db
from .health import FAULTS
from .service import Autopilot, SchedulerAlreadyRunning


def _print_table(df, columns: list[str], empty: str) -> None:
    if df.empty:
        print(empty)
    else:
        print(df[columns].to_string(index=False))


def _dashboard_cmd(settings: Settings) -> list[str]:
    return [
        sys.executable, "-m", "streamlit", "run", str(settings.home / "dashboard" / "streamlit_app.py"),
        "--server.address", "localhost",  # the dashboard can submit and cancel jobs: never expose it on the network
    ]


def _child_env(settings: Settings) -> dict[str, str]:
    return {**os.environ, "HPC_AUTOPILOT_HOME": str(settings.home)}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="hpc", description="HPC Autopilot: a self-driving mini HPC scheduler.")
    parser.add_argument("--home", help="Folder containing cluster.toml (default: this project)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Create the database and register the nodes")
    p = sub.add_parser("scheduler", help="Run the scheduler loop (Ctrl+C to stop)")
    p.add_argument("--until-idle", action="store_true", help="Exit once every queued job has finished")

    p = sub.add_parser("submit", help="Submit a job, like sbatch")
    p.add_argument("command_line", metavar="COMMAND", help='e.g. "python jobs/train_model.py --epochs 5"')
    p.add_argument("--name", required=True)
    p.add_argument("--user", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--role", default="student")
    p.add_argument("--account", default="teaching")
    p.add_argument("--partition", default="gpu")
    p.add_argument("--cpus", type=int, default=1)
    p.add_argument("--mem", type=int, default=4, help="Memory in GB")
    p.add_argument("--gpus", type=int, default=0)
    p.add_argument("--time", type=float, default=10, help="Time limit in minutes")
    p.add_argument("--no-mail", action="store_true", help="Do not email when the job finishes")

    p = sub.add_parser("queue", help="Show jobs, like squeue")
    p.add_argument("--all", action="store_true", help="Include finished jobs")
    sub.add_parser("nodes", help="Show nodes, like sinfo")
    p = sub.add_parser("cancel", help="Cancel a job, like scancel")
    p.add_argument("job_id", type=int)
    p = sub.add_parser("drain", help="Stop new jobs landing on a node")
    p.add_argument("node")
    p.add_argument("--reason", default="Maintenance")
    p = sub.add_parser("resume", help="Return a drained node to service")
    p.add_argument("node")
    p = sub.add_parser("fault", help="Inject or clear a simulated fault (health-check drill)")
    p.add_argument("node")
    p.add_argument("kind", choices=[*FAULTS, "clear"])

    sub.add_parser("demo", help="Submit a batch of sample jobs from several users")
    sub.add_parser("report", help="Write a usage report CSV now")
    sub.add_parser("backup", help="Back up the database now")
    sub.add_parser("dashboard", help="Open the admin dashboard")
    sub.add_parser("up", help="Start the scheduler and the dashboard together")

    args = parser.parse_args(argv)
    settings = load_settings(args.home)
    init_db(settings)

    try:
        _run(args, settings)
    except (ValueError, SchedulerAlreadyRunning) as exc:
        sys.exit(f"error: {exc}")


def _run(args: argparse.Namespace, settings: Settings) -> None:
    match args.command:
        case "init":
            print(f"Database ready at {settings.db_path} with {len(settings.nodes)} nodes.")
        case "scheduler":
            autopilot = Autopilot(settings)
            if args.until_idle:
                autopilot.run_until_idle()
                print("All jobs finished.")
            else:
                print(f"Scheduler running every {settings.tick_seconds:g}s. Press Ctrl+C to stop.")
                autopilot.run_forever()
        case "submit":
            job_id = jobs.submit(
                settings,
                jobs.JobRequest(
                    name=args.name, user=args.user, email=args.email, role=args.role, account=args.account,
                    partition=args.partition, cpus=args.cpus, memory_gb=args.mem, gpus=args.gpus,
                    time_limit_minutes=args.time, command=args.command_line,
                    mail_type="NONE" if args.no_mail else "END",
                ),
            )
            print(f"Submitted batch job {job_id}")
        case "queue":
            df = queries.jobs_frame(settings, view="All" if args.all else "Active")
            _print_table(
                df, ["id", "user", "account", "partition", "name", "state", "reason", "node", "gpus", "priority"],
                "No jobs.",
            )
        case "nodes":
            df = queries.nodes_frame(settings)
            _print_table(
                df, ["name", "partition", "status", "used_cpus", "cpus", "used_gpus", "gpus", "gpu_temp_c", "reason"],
                "No nodes.",
            )
        case "cancel":
            print(jobs.cancel(settings, args.job_id))
        case "drain":
            print(admin.drain_node(settings, args.node, args.reason))
        case "resume":
            print(admin.resume_node(settings, args.node))
        case "fault":
            print(admin.set_fault(settings, args.node, "" if args.kind == "clear" else args.kind))
        case "demo":
            ids = demo.submit_demo_batch(settings)
            print(f"Submitted {len(ids)} demo jobs: {', '.join(map(str, ids))}")
        case "report":
            print(f"Wrote {maintenance.usage_report(settings)}")
        case "backup":
            print(f"Wrote {maintenance.backup_database(settings)}")
        case "dashboard":
            subprocess.call(_dashboard_cmd(settings), cwd=settings.home, env=_child_env(settings))
        case "up":
            _up(settings)


def _up(settings: Settings) -> None:
    """Run the scheduler in the background and the dashboard in the foreground."""
    kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {}
    scheduler = subprocess.Popen(
        [sys.executable, "-m", "hpc_autopilot", "--home", str(settings.home), "scheduler"],
        cwd=settings.home, env=_child_env(settings), **kwargs,
    )
    time.sleep(2)
    if scheduler.poll() is not None:
        sys.exit("error: the scheduler did not start (is another one already running?). See the message above.")
    try:
        subprocess.call(_dashboard_cmd(settings), cwd=settings.home, env=_child_env(settings))
    except KeyboardInterrupt:
        pass
    finally:
        if scheduler.poll() is None:
            scheduler.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
            try:
                scheduler.wait(timeout=20)
            except subprocess.TimeoutExpired:
                scheduler.kill()
        print("Scheduler and dashboard stopped.")


if __name__ == "__main__":
    main()
