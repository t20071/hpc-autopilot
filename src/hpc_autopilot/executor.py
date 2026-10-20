"""Start and stop job processes: the slurmd side.

Jobs run as local processes; the node they "run on" is a logical assignment.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
import time
from collections.abc import Mapping
from pathlib import Path

from .config import Settings
from .uploads import working_dir


def build_argv(settings: Settings, command: str) -> list[str]:
    tokens = shlex.split(command)
    if tokens and tokens[0] in ("python", "python3"):
        tokens[0] = sys.executable
        if len(tokens) > 1 and not os.path.isabs(tokens[1]) and (settings.home / tokens[1]).exists():
            tokens[1] = str(settings.home / tokens[1])
    return tokens


def launch(
    settings: Settings, job: Mapping, node: str, gpu_ids: list[int], attempt: int
) -> tuple[subprocess.Popen, Path]:
    workdir = settings.runs_dir / f"job_{job['id']}" / f"attempt_{attempt}"
    workdir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(
        {
            "HPC_JOB_ID": str(job["id"]),
            "HPC_JOB_NAME": job["name"],
            "HPC_NODE": node,
            "HPC_CPUS": str(job["cpus"]),
            "HPC_JOB_DIR": str(workdir),
            "CUDA_VISIBLE_DEVICES": ",".join(str(g) for g in gpu_ids),
            "PYTHONUNBUFFERED": "1",
        }
    )
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True

    with open(workdir / "output.log", "w", encoding="utf-8") as log:
        log.write(
            f"# job {job['id']} '{job['name']}' attempt {attempt} on {node} "
            f"(GPUs: {','.join(map(str, gpu_ids)) or 'none'}) started {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        )
        log.flush()
        argv = build_argv(settings, job["command"])
        cwd = working_dir(settings, Path(argv[1])) if len(argv) > 1 and argv[1].endswith(".py") else settings.home
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            **kwargs,
        )
    return proc, workdir


def terminate_tree(proc: subprocess.Popen) -> None:
    """Stop a job and any processes it started."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def kill_orphan(pid: int) -> bool:
    """Stop a job process left behind by a scheduler that crashed. Only touches Python processes,
    so a PID that was reused by an unrelated program is left alone."""
    if not pid:
        return False
    if os.name == "nt":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True
        ).stdout.lower()
        if "python" not in out:
            return False
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
        return True
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if b"python" not in f.read():
                return False
        os.killpg(pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        return False
    return True
