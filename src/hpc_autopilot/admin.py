"""Admin actions on nodes: drain, resume, and fault injection for drills."""

from __future__ import annotations

from .config import Settings
from .db import log_event, session
from .health import FAULTS


def _node_exists(conn, name: str) -> None:
    if conn.execute("SELECT 1 FROM nodes WHERE name = ?", (name,)).fetchone() is None:
        raise ValueError(f"Node {name} does not exist")


def drain_node(settings: Settings, name: str, reason: str = "Maintenance", by: str = "admin") -> str:
    with session(settings) as conn:
        _node_exists(conn, name)
        conn.execute(
            "UPDATE nodes SET state = 'drain', reason = ?, drain_source = 'admin' WHERE name = ?",
            (reason or "Maintenance", name),
        )
        log_event(conn, "info", "admin", f"{name} drained by {by}: {reason}")
    return f"{name} drained. Running jobs will finish; no new jobs will start there."


def resume_node(settings: Settings, name: str, by: str = "admin") -> str:
    with session(settings) as conn:
        _node_exists(conn, name)
        conn.execute("UPDATE nodes SET state = 'up', reason = '', drain_source = '' WHERE name = ?", (name,))
        log_event(conn, "info", "admin", f"{name} resumed by {by}")
    return f"{name} resumed and accepting jobs"


def set_fault(settings: Settings, name: str, fault: str, by: str = "admin") -> str:
    if fault and fault not in FAULTS:
        raise ValueError(f"Unknown fault '{fault}' (choose {', '.join(FAULTS)})")
    with session(settings) as conn:
        _node_exists(conn, name)
        conn.execute("UPDATE nodes SET fault = ? WHERE name = ?", (fault, name))
        if fault:
            log_event(conn, "warning", "drill", f"{FAULTS[fault]} injected on {name} by {by}")
        else:
            log_event(conn, "info", "drill", f"Faults cleared on {name} by {by}")
    if fault:
        return f"{FAULTS[fault]} injected on {name}. Watch the health check react within a few seconds."
    return f"Faults cleared on {name}. The health check will resume it automatically."
