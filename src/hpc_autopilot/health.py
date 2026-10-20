"""Node health checks: auto-drain on faults, auto-resume on recovery.

GPU temperatures are simulated from each node's load. Faults are injected from the
dashboard or CLI so the automatic response can be seen without real hardware.
"""

from __future__ import annotations

import random
import sqlite3

from .config import Settings
from .db import log_event
from .notify import alert_admin

FAULTS = {
    "gpu_overheat": "Simulated GPU overheating",
    "ecc_error": "Simulated uncorrectable GPU memory (ECC) error",
    "node_down": "Simulated node failure (heartbeat lost)",
}


def check_nodes(conn: sqlite3.Connection, settings: Settings, now: float, rng: random.Random) -> list[str]:
    """Update node health. Returns the nodes that just went down, whose jobs must be requeued."""
    load = {
        r["node"]: (r["cpus"], r["gpus"])
        for r in conn.execute(
            "SELECT node, SUM(cpus) AS cpus, SUM(gpus) AS gpus FROM jobs WHERE state = 'RUNNING' GROUP BY node"
        )
    }
    went_down = []
    for node in conn.execute("SELECT * FROM nodes").fetchall():
        used_cpus, used_gpus = load.get(node["name"], (0, 0))
        util = used_gpus / node["gpus"] if node["gpus"] else used_cpus / node["cpus"]
        temp = 34 + 42 * util + rng.uniform(-1.5, 1.5)
        if node["fault"] == "gpu_overheat":
            temp = 91 + rng.uniform(0, 4)
        conn.execute("UPDATE nodes SET gpu_temp_c = ?, updated_at = ? WHERE name = ?", (round(temp, 1), now, node["name"]))

        problem, new_state = None, "drain"
        if node["fault"] == "node_down":
            problem, new_state = "Node not responding (heartbeat lost)", "down"
        elif node["fault"] == "ecc_error":
            problem = "Uncorrectable GPU memory (ECC) error"
        elif node["gpus"] and temp > settings.gpu_temp_limit_c:
            problem = f"GPU temperature {temp:.0f} C is above the {settings.gpu_temp_limit_c:.0f} C limit"

        if problem and (node["state"] == "up" or (new_state == "down" and node["state"] != "down")):
            conn.execute(
                # keep an admin drain: the admin, not the health check, decides when that node returns
                "UPDATE nodes SET state = ?, reason = ?, "
                "drain_source = CASE WHEN drain_source = 'admin' THEN 'admin' ELSE 'health' END WHERE name = ?",
                (new_state, problem, node["name"]),
            )
            action = "marked down; its jobs will be requeued" if new_state == "down" else "drained"
            log_event(conn, "warning", "health", f"{node['name']}: {problem}. Node {action}.")
            alert_admin(
                conn, settings, f"{node['name']} {action}",
                f"Health check failed on {node['name']}: {problem}.\n"
                f"The node was {action} automatically. Running jobs on a drained node are allowed to finish.\n"
                "It will be resumed automatically once the health check passes again.",
            )
            if new_state == "down":
                went_down.append(node["name"])
        elif not problem and node["state"] != "up" and node["drain_source"] == "health" and settings.auto_resume:
            conn.execute("UPDATE nodes SET state = 'up', reason = '', drain_source = '' WHERE name = ?", (node["name"],))
            log_event(conn, "info", "health", f"{node['name']}: health check passed. Node resumed automatically.")
            alert_admin(conn, settings, f"{node['name']} resumed", f"{node['name']} passed its health check and is accepting jobs again.")
    return went_down
