"""Housekeeping that runs on a timer: database backup, usage reports, output cleanup."""

from __future__ import annotations

import shutil
import sqlite3
import time
from pathlib import Path

from .config import Settings
from .db import get_meta, log_event, set_meta


def backup_database(settings: Settings) -> Path:
    """Online SQLite backup, keeping the newest `backup_keep` copies."""
    settings.backups_dir.mkdir(parents=True, exist_ok=True)
    dest = settings.backups_dir / f"hpc-{time.strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(settings.db_path)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    for old in sorted(settings.backups_dir.glob("hpc-*.db"))[: -max(1, settings.backup_keep)]:
        old.unlink(missing_ok=True)
    return dest


def usage_report(settings: Settings) -> Path:
    from .queries import usage_by_user  # imported here to keep pandas out of the scheduler's startup path

    settings.reports_dir.mkdir(parents=True, exist_ok=True)
    dest = settings.reports_dir / f"usage-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    usage_by_user(settings).to_csv(dest, index=False)
    return dest


def purge_old_outputs(settings: Settings, now: float) -> int:
    """Delete job output folders older than `purge_after_days`, like a scratch purge policy."""
    if not settings.runs_dir.exists():
        return 0
    cutoff = now - settings.purge_after_days * 86400
    removed = 0
    for job_dir in settings.runs_dir.glob("job_*"):
        if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
            shutil.rmtree(job_dir, ignore_errors=True)
            removed += 1
    return removed


def run_due_tasks(conn: sqlite3.Connection, settings: Settings, now: float) -> list[str]:
    tasks = [
        ("last_backup", settings.backup_every_minutes * 60, lambda: f"Database backed up to {backup_database(settings).name}"),
        ("last_report", settings.report_every_minutes * 60, lambda: f"Usage report written to {usage_report(settings).name}"),
        ("last_purge", 24 * 3600, lambda: f"Purged {purge_old_outputs(settings, now)} old job output folder(s)"),
    ]
    done = []
    for key, every_s, task in tasks:
        last = float(get_meta(conn, key, "0") or 0)
        if now - last < every_s:
            continue
        set_meta(conn, key, str(now))
        try:
            message = task()
            log_event(conn, "info", "maintenance", message)
            done.append(message)
        except Exception as exc:
            log_event(conn, "error", "maintenance", f"{key.removeprefix('last_')} failed: {exc}")
    return done
