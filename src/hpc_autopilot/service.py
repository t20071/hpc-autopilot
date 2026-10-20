"""The scheduler daemon: the loop that makes the cluster run itself.

Every tick it checks node health, stops cancelled or overrunning jobs, collects
finished ones, schedules waiting jobs onto free nodes, emails users, records
metrics and runs housekeeping. None of it needs an admin to step in.
"""

from __future__ import annotations

import os
import random
import signal
import sqlite3
import subprocess
import threading
import time
import traceback

from . import executor, health, maintenance, notify
from .config import Settings
from .db import get_meta, init_db, log_event, session, set_meta
from .policy import NodeState, PendingJob, RunningJob, decayed_usage, plan_schedule

SNAPSHOT_EVERY_S = 5


class SchedulerAlreadyRunning(RuntimeError):
    pass


class Autopilot:
    def __init__(self, settings: Settings, seed: int | None = None):
        self.settings = settings
        self.procs: dict[int, subprocess.Popen] = {}
        self.rng = random.Random(seed)
        self._last_snapshot = 0.0
        self._lock_file = None
        self._stop_mailer = threading.Event()
        self._mailer: threading.Thread | None = None

    # --- lifecycle -------------------------------------------------------------------

    def _acquire_lock(self) -> None:
        """An OS-level lock, so two schedulers can never drive the same cluster."""
        path = self.settings.db_path.parent / "scheduler.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        f = open(path, "a+")
        try:
            if os.name == "nt":
                import msvcrt

                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            f.close()
            raise SchedulerAlreadyRunning("Another scheduler is already running for this cluster") from None
        self._lock_file = f

    def _release_lock(self) -> None:
        if self._lock_file is not None:
            self._lock_file.close()  # closing the handle releases the lock
            self._lock_file = None
        self._stop_mailer = threading.Event()
        self._mailer: threading.Thread | None = None

    def startup(self, check_running: bool = True) -> None:
        init_db(self.settings)
        if check_running:
            self._acquire_lock()
        with session(self.settings) as conn:
            for row in conn.execute("SELECT id, pid, cancel_requested FROM jobs WHERE state = 'RUNNING'").fetchall():
                if row["pid"] and executor.kill_orphan(row["pid"]):
                    log_event(conn, "warning", "scheduler", f"Stopped leftover process {row['pid']} of job {row['id']}")
                if row["cancel_requested"]:
                    conn.execute(
                        "UPDATE jobs SET state = 'CANCELLED', reason = 'Cancelled while running', end_time = ? WHERE id = ?",
                        (time.time(), row["id"]),
                    )
                else:
                    self._requeue(conn, row["id"], "Requeued after scheduler restart")
            for key in ("last_backup", "last_report", "last_purge"):  # first housekeeping runs one period after setup
                if get_meta(conn, key) is None:
                    set_meta(conn, key, str(time.time()))
        if self.settings.email_mode == "smtp" and self._mailer is None:
            self._stop_mailer.clear()
            self._mailer = threading.Thread(target=self._mail_loop, name="hpc-mailer", daemon=True)
            self._mailer.start()

    def _mail_loop(self) -> None:
        """Deliver queued emails on a separate thread, so a slow mail server never delays scheduling."""
        while not self._stop_mailer.wait(2):
            try:
                notify.deliver_queued(self.settings)
            except Exception:
                with session(self.settings) as conn:
                    log_event(conn, "error", "email", "Mailer failed: " + traceback.format_exc(limit=2))
            log_event(
                conn, "info", "scheduler",
                f"Scheduler started: {len(self.settings.nodes)} nodes, tick every {self.settings.tick_seconds:g}s",
            )

    def run_forever(self) -> None:
        self.startup()

        def stop(*_):
            raise KeyboardInterrupt

        signal.signal(signal.SIGBREAK if os.name == "nt" else signal.SIGTERM, stop)
        try:
            while True:
                started = time.time()
                try:
                    self.tick()
                except Exception:
                    with session(self.settings) as conn:
                        log_event(conn, "error", "scheduler", "Tick failed: " + traceback.format_exc(limit=3))
                time.sleep(max(0.2, self.settings.tick_seconds - (time.time() - started)))
        except KeyboardInterrupt:
            pass
        finally:
            self.shutdown()

    def run_until_idle(self, timeout_s: float = 3600) -> None:
        """Run the loop until no job is pending or running (handy for scripts and tests)."""
        self.startup()
        deadline = time.time() + timeout_s
        try:
            while time.time() < deadline:
                self.tick()
                with session(self.settings) as conn:
                    active = conn.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('PENDING', 'RUNNING')").fetchone()[0]
                if not active and not self.procs:
                    break
                time.sleep(self.settings.tick_seconds)
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        with session(self.settings) as conn:
            for job_id, proc in list(self.procs.items()):
                executor.terminate_tree(proc)
                self._requeue(conn, job_id, "Requeued: scheduler stopped")
            self.procs.clear()
            set_meta(conn, "scheduler_heartbeat", "0")
            log_event(conn, "info", "scheduler", "Scheduler stopped")
        if self._mailer is not None:
            self._stop_mailer.set()
            self._mailer.join(timeout=15)
            self._mailer = None
        self._release_lock()

    # --- one pass of the loop --------------------------------------------------------

    def tick(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with session(self.settings) as conn:
            set_meta(conn, "scheduler_heartbeat", str(now))
            for node in health.check_nodes(conn, self.settings, now, self.rng):
                self._requeue_node(conn, node)
            self._handle_cancellations(conn, now)
            self._collect_finished(conn, now)
            self._schedule(conn, now)
            notify.notify_finished_jobs(conn, self.settings, now)
            self._snapshot(conn, now)
            maintenance.run_due_tasks(conn, self.settings, now)

    # --- steps -----------------------------------------------------------------------

    def _requeue(self, conn: sqlite3.Connection, job_id: int, reason: str) -> None:
        conn.execute(
            "UPDATE jobs SET state = 'PENDING', reason = ?, node = NULL, gpu_ids = '', pid = NULL, "
            "start_time = NULL, backfilled = 0, cancel_requested = 0 WHERE id = ?",
            (reason, job_id),
        )
        log_event(conn, "warning", "job", f"Job {job_id}: {reason}")

    def _requeue_node(self, conn: sqlite3.Connection, node: str) -> None:
        for row in conn.execute("SELECT id FROM jobs WHERE state = 'RUNNING' AND node = ?", (node,)).fetchall():
            proc = self.procs.pop(row["id"], None)
            if proc:
                executor.terminate_tree(proc)
            self._requeue(conn, row["id"], f"Requeued: node {node} failed")

    def _handle_cancellations(self, conn: sqlite3.Connection, now: float) -> None:
        rows = conn.execute("SELECT id FROM jobs WHERE state = 'RUNNING' AND cancel_requested = 1").fetchall()
        for row in rows:
            proc = self.procs.pop(row["id"], None)
            if proc:
                executor.terminate_tree(proc)
            conn.execute(
                "UPDATE jobs SET state = 'CANCELLED', reason = 'Cancelled while running', end_time = ? WHERE id = ?",
                (now, row["id"]),
            )
            log_event(conn, "info", "job", f"Job {row['id']} cancelled while running")

    def _collect_finished(self, conn: sqlite3.Connection, now: float) -> None:
        for job_id, proc in list(self.procs.items()):
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None or row["state"] != "RUNNING":
                executor.terminate_tree(proc)
                self.procs.pop(job_id)
                continue
            code = proc.poll()
            if code is None:
                if now - row["start_time"] > row["time_limit_s"]:
                    executor.terminate_tree(proc)
                    self.procs.pop(job_id)
                    self._finish(conn, row, "TIMEOUT", None, f"Reached its time limit of {row['time_limit_s'] / 60:g} min", now)
                continue
            self.procs.pop(job_id)
            if code == 0:
                self._finish(conn, row, "COMPLETED", 0, "", now)
            else:
                self._finish(conn, row, "FAILED", code, f"Exit code {code}", now)

    def _finish(self, conn: sqlite3.Connection, row: sqlite3.Row, state: str, code: int | None, reason: str, now: float) -> None:
        conn.execute(
            "UPDATE jobs SET state = ?, exit_code = ?, reason = ?, end_time = ? WHERE id = ?",
            (state, code, reason, now, row["id"]),
        )
        detail = f": {reason}" if reason else ""
        log_event(
            conn, "info" if state == "COMPLETED" else "warning", "job",
            f"Job {row['id']} ({row['name']}) {state.lower()} on {row['node']}{detail}",
        )

    def _schedule(self, conn: sqlite3.Connection, now: float) -> None:
        pending_rows = conn.execute("SELECT * FROM jobs WHERE state = 'PENDING'").fetchall()
        if not pending_rows:
            return
        nodes = {
            n["name"]: NodeState(n["name"], n["partition"], n["cpus"], n["memory_gb"], n["gpus"], available=n["state"] == "up")
            for n in conn.execute("SELECT * FROM nodes")
        }
        used_gpu_ids: dict[str, set[int]] = {name: set() for name in nodes}
        running = []
        for r in conn.execute("SELECT * FROM jobs WHERE state = 'RUNNING'"):
            job = RunningJob(r["id"], r["user"], r["account"], r["node"], r["cpus"], r["memory_gb"], r["gpus"], r["start_time"], r["time_limit_s"])
            running.append(job)
            if r["node"] in nodes:
                nodes[r["node"]].allocate(job)
                used_gpu_ids[r["node"]].update(int(g) for g in r["gpu_ids"].split(",") if g)

        pending = [
            PendingJob(r["id"], r["user"], r["role"], r["account"], r["partition"], r["cpus"], r["memory_gb"],
                       r["gpus"], r["time_limit_s"], r["submit_time"])
            for r in pending_rows
            if r["role"] in self.settings.qos
        ]
        usage_rows = conn.execute(
            "SELECT account, cpus, gpus, start_time, end_time FROM jobs WHERE start_time IS NOT NULL AND start_time > ?",
            (now - 30 * 86400,),
        ).fetchall()
        plan = plan_schedule(pending, list(nodes.values()), running, now, self.settings, decayed_usage(usage_rows, now, self.settings))

        starting = {job_id for job_id, _ in plan.starts}
        conn.executemany(
            "UPDATE jobs SET priority = ?, reason = ? WHERE id = ? AND state = 'PENDING'",
            [(plan.priorities[j.id], plan.reasons.get(j.id, ""), j.id) for j in pending if j.id not in starting],
        )
        by_id = {r["id"]: r for r in pending_rows}
        for job_id, node in plan.starts:
            row = by_id[job_id]
            gpu_ids = [g for g in range(nodes[node].gpus) if g not in used_gpu_ids[node]][: row["gpus"]]
            used_gpu_ids[node].update(gpu_ids)
            self._start(conn, row, node, gpu_ids, plan.priorities[job_id], job_id in plan.backfilled, now)

    def _start(self, conn, row, node: str, gpu_ids: list[int], priority: float, backfilled: bool, now: float) -> None:
        attempt = row["attempt"] + 1
        try:
            proc, workdir = executor.launch(self.settings, row, node, gpu_ids, attempt)
        except Exception as exc:
            conn.execute(
                "UPDATE jobs SET state = 'FAILED', reason = ?, end_time = ?, attempt = ? WHERE id = ?",
                (f"Could not start: {exc}", now, attempt, row["id"]),
            )
            log_event(conn, "error", "job", f"Job {row['id']} could not start: {exc}")
            return
        cur = conn.execute(
            "UPDATE jobs SET state = 'RUNNING', node = ?, gpu_ids = ?, pid = ?, start_time = ?, attempt = ?, "
            "workdir = ?, priority = ?, backfilled = ?, reason = ? WHERE id = ? AND state = 'PENDING'",
            (node, ",".join(map(str, gpu_ids)), proc.pid, now, attempt, str(workdir), priority,
             int(backfilled), "Backfilled" if backfilled else "", row["id"]),
        )
        if cur.rowcount == 0:  # cancelled while it was being started
            executor.terminate_tree(proc)
            return
        self.procs[row["id"]] = proc
        gpus = f", GPUs {','.join(map(str, gpu_ids))}" if gpu_ids else ""
        how = " via backfill" if backfilled else ""
        log_event(conn, "info", "scheduler", f"Job {row['id']} ({row['name']}) started on {node}{gpus}{how}")

    def _snapshot(self, conn: sqlite3.Connection, now: float) -> None:
        if now - self._last_snapshot < SNAPSHOT_EVERY_S:
            return
        self._last_snapshot = now
        nodes = conn.execute("SELECT state, cpus, gpus FROM nodes").fetchall()
        cpus, gpus, running = conn.execute(
            "SELECT COALESCE(SUM(cpus), 0), COALESCE(SUM(gpus), 0), COUNT(*) FROM jobs WHERE state = 'RUNNING'"
        ).fetchone()
        pending = conn.execute("SELECT COUNT(*) FROM jobs WHERE state = 'PENDING'").fetchone()[0]
        conn.execute(
            "INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                now, running, pending, gpus, sum(n["gpus"] for n in nodes), cpus, sum(n["cpus"] for n in nodes),
                sum(1 for n in nodes if n["state"] == "up"), len(nodes),
            ),
        )
        conn.execute("DELETE FROM snapshots WHERE ts < ?", (now - 86400,))
