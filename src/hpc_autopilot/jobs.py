"""Job submission, validation and cancellation: the sbatch / scancel side."""

from __future__ import annotations

import ast
import re
import shlex
import time
from dataclasses import dataclass

from .config import Settings
from .db import log_event, session

USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,31}$")
EMAIL = re.compile(r"^[^@\s<>,;\"']+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def normalize_command(command: str) -> str:
    r"""Accept Windows-style 'python jobs\x.py' as well as 'python jobs/x.py'."""
    return re.sub(r"^(python3?\s+)jobs\\", r"\1jobs/", command.strip())


@dataclass
class JobRequest:
    name: str
    user: str
    email: str
    role: str
    account: str
    partition: str
    cpus: int = 1
    memory_gb: int = 4
    gpus: int = 0
    time_limit_minutes: float = 10
    command: str = "python jobs/monte_carlo_pi.py"
    mail_type: str = "END"  # END = email when the job finishes; NONE = no email


def list_templates(settings: Settings) -> list[tuple[str, str]]:
    """Workload scripts users may run, as (command, one-line description)."""
    templates = []
    for path in sorted(settings.jobs_dir.glob("*.py")):
        doc = ast.get_docstring(ast.parse(path.read_text(encoding="utf-8"))) or ""
        templates.append((f"python jobs/{path.name}", doc.strip().splitlines()[0] if doc else ""))
    return templates


def command_allowed(settings: Settings, command: str) -> bool:
    if settings.allow_custom_commands:
        return True
    try:
        tokens = shlex.split(normalize_command(command))
    except ValueError:
        return False
    if len(tokens) < 2 or tokens[0] not in ("python", "python3"):
        return False
    script = (settings.home / tokens[1]).resolve()
    # any .py file inside the jobs folder, including user uploads in jobs/uploads/<user>/
    return script.is_relative_to(settings.jobs_dir.resolve()) and script.suffix == ".py" and script.is_file()


def validate(settings: Settings, req: JobRequest) -> list[str]:
    errors = []
    if any(CONTROL.search(v) for v in (req.name, req.user, req.email, req.command)):
        errors.append("Fields cannot contain line breaks or control characters")
    if not req.name.strip() or len(req.name) > 80:
        errors.append("Job name is required (at most 80 characters)")
    if not USERNAME.match(req.user.strip()):
        errors.append("Username must start with a letter and use only letters, digits, '.', '_' or '-' (max 32)")
    if req.mail_type not in ("END", "NONE"):
        errors.append("mail_type must be END or NONE")
    if req.mail_type != "NONE" and not EMAIL.match(req.email.strip()):
        errors.append("A valid email address is required")
    registered = settings.users.get(req.user.strip())
    if registered is None and settings.require_known_users:
        errors.append(f"User '{req.user}' is not registered on this cluster")
    elif registered is not None and (req.role, req.account) != registered:
        errors.append(f"User '{req.user}' is registered as role '{registered[0]}' on account '{registered[1]}'")
    qos = settings.qos.get(req.role)
    if qos is None:
        errors.append(f"Unknown role '{req.role}' (choose {', '.join(settings.qos)})")
    if req.account not in settings.account_shares:
        errors.append(f"Unknown account '{req.account}' (choose {', '.join(settings.account_shares)})")
    if req.partition not in settings.partitions:
        errors.append(f"Unknown partition '{req.partition}' (choose {', '.join(settings.partitions)})")
    if req.cpus < 1 or req.memory_gb < 1 or req.gpus < 0 or not 0 < req.time_limit_minutes < float("inf"):
        errors.append("CPUs, memory and time limit must be positive, and GPUs cannot be negative")
    if qos is not None:
        if req.time_limit_minutes > qos.max_time_minutes:
            errors.append(f"Time limit is above the {req.role} maximum of {qos.max_time_minutes:g} minutes")
        if req.gpus > qos.max_gpus_per_user:
            errors.append(f"A {req.role} can use at most {qos.max_gpus_per_user} GPU(s) at a time")
    fits = any(
        n.partition == req.partition and n.cpus >= req.cpus and n.memory_gb >= req.memory_gb and n.gpus >= req.gpus
        for n in settings.nodes
    )
    if not fits:
        errors.append(f"Requested node configuration is not available in partition '{req.partition}'")
    if not command_allowed(settings, req.command):
        errors.append(
            "Only scripts in the jobs folder can be run, e.g. 'python jobs/train_model.py --epochs 5' "
            "(an admin can change this with security.allow_custom_commands)"
        )
    return errors


def submit(settings: Settings, req: JobRequest) -> int:
    errors = validate(settings, req)
    if errors:
        raise ValueError("; ".join(errors))
    with session(settings) as conn:
        cur = conn.execute(
            """
            INSERT INTO jobs (name, user, email, role, account, partition, cpus, memory_gb, gpus,
                              time_limit_s, command, mail_type, state, reason, submit_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'Queued', ?)
            """,
            (
                req.name.strip(), req.user.strip(), req.email.strip(), req.role, req.account, req.partition,
                req.cpus, req.memory_gb, req.gpus, req.time_limit_minutes * 60, normalize_command(req.command),
                req.mail_type, time.time(),
            ),
        )
        job_id = cur.lastrowid
        log_event(conn, "info", "job", f"Job {job_id} ({req.name}) submitted by {req.user} [{req.role}, {req.account}]")
    return job_id


def cancel(settings: Settings, job_id: int, by: str = "admin") -> str:
    with session(settings) as conn:
        row = conn.execute("SELECT state FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ValueError(f"Job {job_id} does not exist")
        if row["state"] == "PENDING":
            conn.execute(
                "UPDATE jobs SET state = 'CANCELLED', reason = ?, end_time = ? WHERE id = ? AND state = 'PENDING'",
                (f"Cancelled by {by}", time.time(), job_id),
            )
            message = f"Job {job_id} cancelled"
        elif row["state"] == "RUNNING":
            conn.execute("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", (job_id,))
            message = f"Job {job_id} will be stopped within a few seconds"
        else:
            raise ValueError(f"Job {job_id} has already finished ({row['state']})")
        log_event(conn, "info", "job", f"Job {job_id} cancellation requested by {by}")
    return message
