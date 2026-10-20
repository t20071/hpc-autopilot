"""Email notifications, sent over SMTP or written to a local outbox folder."""

from __future__ import annotations

import os
import smtplib
import sqlite3
import ssl
import time
import uuid
from collections.abc import Mapping
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from .config import Settings
from .db import TERMINAL_STATES, log_event, session

HEADLINES = {
    "COMPLETED": "Your job is completed.",
    "FAILED": "Your job has failed.",
    "TIMEOUT": "Your job was stopped because it reached its time limit.",
    "CANCELLED": "Your job was cancelled.",
}

MAX_ATTEMPTS = 5
SMTP_TIMEOUT_S = 10


def _build(settings: Settings, to_addr: str, subject: str, body: str) -> EmailMessage:
    msg = EmailMessage()  # raises on header injection (line breaks in a header)
    msg["From"] = settings.email_from
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="hpc-autopilot.local")
    msg.set_content(body)
    return msg


def _smtp_send(settings: Settings, msg: EmailMessage) -> None:
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=SMTP_TIMEOUT_S) as smtp:
        if settings.smtp_starttls:
            smtp.starttls(context=ssl.create_default_context())  # verifies the server certificate
        if settings.smtp_user:
            if not settings.smtp_starttls:
                raise RuntimeError("refusing to send the SMTP password without STARTTLS")
            smtp.login(settings.smtp_user, os.environ.get("HPC_SMTP_PASSWORD", ""))
        smtp.send_message(msg)


def send(
    conn: sqlite3.Connection, settings: Settings, to_addr: str, subject: str, body: str, job_id: int | None = None
) -> str:
    """Record one email. In SMTP mode it is queued for the background mailer, so a slow mail server
    never holds up scheduling; in outbox mode it is written at once. Returns 'queued', 'outbox' or
    'failed: <reason>'; never raises."""
    try:
        msg = _build(settings, to_addr, subject, body)
        if settings.email_mode == "smtp":
            status = "queued"
        else:
            settings.outbox_dir.mkdir(parents=True, exist_ok=True)
            name = f"{time.strftime('%Y%m%d-%H%M%S')}-{job_id or 'admin'}-{uuid.uuid4().hex[:6]}.eml"
            (settings.outbox_dir / name).write_bytes(bytes(msg))
            status = "outbox"
    except Exception as exc:  # keep the scheduler running if the disk is full or a header is bad
        status = f"failed: {exc}"
        log_event(conn, "error", "email", f"Could not send '{subject}' to {to_addr}: {exc}")

    conn.execute(
        "INSERT INTO emails (ts, job_id, to_addr, subject, body, status) VALUES (?, ?, ?, ?, ?, ?)",
        (time.time(), job_id, to_addr, subject, body, status),
    )
    return status


def deliver_queued(settings: Settings, now: float | None = None, limit: int = 20) -> int:
    """Send queued emails over SMTP (called by the mailer thread). Failures are retried with
    backoff, up to MAX_ATTEMPTS, then marked failed and logged. Returns how many were sent."""
    now = time.time() if now is None else now
    with session(settings) as conn:
        rows = conn.execute(
            "SELECT * FROM emails WHERE status = 'queued' AND next_try <= ? ORDER BY id LIMIT ?", (now, limit)
        ).fetchall()
    sent = 0
    for row in rows:
        try:
            _smtp_send(settings, _build(settings, row["to_addr"], row["subject"], row["body"]))
            update = ("sent", row["attempts"] + 1, 0.0)
            sent += 1
        except Exception as exc:
            attempts = row["attempts"] + 1
            if attempts >= MAX_ATTEMPTS:
                update = (f"failed: {exc}", attempts, 0.0)
            else:
                update = ("queued", attempts, now + 30 * 2**attempts)
        with session(settings) as conn:  # short write, so the scheduler is never blocked on the mailer
            conn.execute("UPDATE emails SET status = ?, attempts = ?, next_try = ? WHERE id = ?", (*update, row["id"]))
            if update[0].startswith("failed"):
                log_event(conn, "error", "email", f"Gave up emailing {row['to_addr']} ('{row['subject']}') after {update[1]} attempts: {update[0][8:]}")
    return sent


def _fmt_time(ts: float | None) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else "-"


def _fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    seconds = int(seconds)
    return f"{seconds // 3600}h {seconds % 3600 // 60}m {seconds % 60}s"


def job_message(job: Mapping) -> tuple[str, str]:
    state = job["state"]
    verb = {"COMPLETED": "completed", "FAILED": "failed", "TIMEOUT": "timed out", "CANCELLED": "cancelled"}[state]
    subject = f"[HPC] Job {job['id']} ({job['name']}) {verb}"
    runtime = job["end_time"] - job["start_time"] if job["start_time"] and job["end_time"] else None
    lines = [
        f"Dear {job['user']},",
        "",
        HEADLINES[state],
        "",
        f"Job ID:      {job['id']}",
        f"Job name:    {job['name']}",
        f"Node:        {job['node'] or '-'}",
        f"GPUs:        {job['gpus']}",
        f"Submitted:   {_fmt_time(job['submit_time'])}",
        f"Started:     {_fmt_time(job['start_time'])}",
        f"Finished:    {_fmt_time(job['end_time'])}",
        f"Run time:    {_fmt_duration(runtime)}",
        f"Exit code:   {job['exit_code'] if job['exit_code'] is not None else '-'}",
    ]
    if job["reason"]:
        lines.append(f"Details:     {job['reason']}")
    if job["workdir"]:
        lines.append(f"Output:      {job['workdir']}{os.sep}output.log")
    if state == "FAILED":
        lines += ["", "Check the output log for the error. Reply to the HPC team if you need help."]
    if state == "TIMEOUT":
        lines += ["", "Ask for a longer time limit, or save checkpoints so the job can resume."]
    lines += ["", "This is an automated message from HPC Autopilot."]
    return subject, "\n".join(lines)


def notify_finished_jobs(conn: sqlite3.Connection, settings: Settings, now: float | None = None) -> int:
    """Email the owner of every finished job once. Failed sends are retried with backoff, then reported."""
    now = time.time() if now is None else now
    placeholders = ",".join("?" * len(TERMINAL_STATES))
    rows = conn.execute(
        f"SELECT * FROM jobs WHERE notified = 0 AND notify_after <= ? AND state IN ({placeholders})",
        (now, *TERMINAL_STATES),
    ).fetchall()
    for job in rows:
        if job["mail_type"] == "NONE":
            conn.execute("UPDATE jobs SET notified = 1 WHERE id = ?", (job["id"],))
            continue
        try:
            subject, body = job_message(job)
            status = send(conn, settings, job["email"], subject, body, job_id=job["id"])
        except Exception as exc:  # one bad row must not block everyone else's email
            status = f"failed: {exc}"
        if not status.startswith("failed"):
            conn.execute("UPDATE jobs SET notified = 1 WHERE id = ?", (job["id"],))
            continue
        attempts = job["notify_attempts"] + 1
        if attempts >= MAX_ATTEMPTS:
            conn.execute("UPDATE jobs SET notified = 2, notify_attempts = ? WHERE id = ?", (attempts, job["id"]))
            log_event(conn, "error", "email", f"Gave up emailing {job['email']} about job {job['id']} after {attempts} attempts")
        else:
            conn.execute(
                "UPDATE jobs SET notify_attempts = ?, notify_after = ? WHERE id = ?",
                (attempts, now + 30 * 2**attempts, job["id"]),
            )
    return len(rows)


def alert_admin(conn: sqlite3.Connection, settings: Settings, subject: str, body: str) -> None:
    send(conn, settings, settings.admin_email, f"[HPC ALERT] {subject}", body + "\n\nHPC Autopilot")
