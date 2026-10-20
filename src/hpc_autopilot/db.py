"""SQLite storage shared by the scheduler, the CLI and the dashboard."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager

from .config import Settings

TERMINAL_STATES = ("COMPLETED", "FAILED", "TIMEOUT", "CANCELLED")

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    name TEXT PRIMARY KEY,
    partition TEXT NOT NULL,
    cpus INTEGER NOT NULL,
    memory_gb INTEGER NOT NULL,
    gpus INTEGER NOT NULL,
    gpu_type TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'up',
    reason TEXT NOT NULL DEFAULT '',
    drain_source TEXT NOT NULL DEFAULT '',
    fault TEXT NOT NULL DEFAULT '',
    gpu_temp_c REAL NOT NULL DEFAULT 35,
    updated_at REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    account TEXT NOT NULL,
    partition TEXT NOT NULL,
    cpus INTEGER NOT NULL,
    memory_gb INTEGER NOT NULL,
    gpus INTEGER NOT NULL,
    time_limit_s REAL NOT NULL,
    command TEXT NOT NULL,
    mail_type TEXT NOT NULL DEFAULT 'END',
    state TEXT NOT NULL DEFAULT 'PENDING',
    reason TEXT NOT NULL DEFAULT '',
    priority REAL NOT NULL DEFAULT 0,
    node TEXT,
    gpu_ids TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    exit_code INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    backfilled INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    notified INTEGER NOT NULL DEFAULT 0,          -- 0 = to do, 1 = done, 2 = gave up after retries
    notify_attempts INTEGER NOT NULL DEFAULT 0,
    notify_after REAL NOT NULL DEFAULT 0,
    workdir TEXT NOT NULL DEFAULT '',
    submit_time REAL NOT NULL,
    start_time REAL,
    end_time REAL
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    job_id INTEGER,
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,                       -- queued, sent, outbox or failed: <reason>
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snapshots (
    ts REAL PRIMARY KEY,
    running INTEGER NOT NULL,
    pending INTEGER NOT NULL,
    gpus_alloc INTEGER NOT NULL,
    gpus_total INTEGER NOT NULL,
    cpus_alloc INTEGER NOT NULL,
    cpus_total INTEGER NOT NULL,
    nodes_up INTEGER NOT NULL,
    nodes_total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(settings: Settings) -> sqlite3.Connection:
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path, timeout=15, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


@contextmanager
def session(settings: Settings) -> Iterator[sqlite3.Connection]:
    conn = connect(settings)
    try:
        yield conn
    finally:
        conn.close()


def init_db(settings: Settings) -> None:
    with session(settings) as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        sync_nodes(conn, settings)


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after a database was first created."""
    for table, column, ddl in (
        ("jobs", "notify_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("jobs", "notify_after", "REAL NOT NULL DEFAULT 0"),
        ("emails", "attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("emails", "next_try", "REAL NOT NULL DEFAULT 0"),
    ):
        if column not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def sync_nodes(conn: sqlite3.Connection, settings: Settings) -> None:
    """Make the nodes table match cluster.toml, keeping each node's current state."""
    for n in settings.nodes:
        conn.execute(
            """
            INSERT INTO nodes (name, partition, cpus, memory_gb, gpus, gpu_type, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                partition = excluded.partition, cpus = excluded.cpus,
                memory_gb = excluded.memory_gb, gpus = excluded.gpus, gpu_type = excluded.gpu_type
            """,
            (n.name, n.partition, n.cpus, n.memory_gb, n.gpus, n.gpu_type, time.time()),
        )
    names = [n.name for n in settings.nodes]
    conn.execute(f"DELETE FROM nodes WHERE name NOT IN ({','.join('?' * len(names))})", names)


def log_event(conn: sqlite3.Connection, level: str, category: str, message: str) -> None:
    conn.execute(
        "INSERT INTO events (ts, level, category, message) VALUES (?, ?, ?, ?)",
        (time.time(), level, category, message),
    )


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
