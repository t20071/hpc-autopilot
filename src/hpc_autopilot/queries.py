"""Read-only views of the cluster for the dashboard and CLI."""

from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

from .config import Settings
from .db import get_meta, session
from .policy import decayed_usage, fairshare_factor

ACTIVE_STATES = ("PENDING", "RUNNING")
FINISHED_STATES = ("COMPLETED", "FAILED", "TIMEOUT", "CANCELLED")


def _local(series: pd.Series) -> pd.Series:
    """Unix seconds to naive local datetimes, for display."""
    return pd.to_datetime(series.map(lambda t: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if pd.notna(t) else None))


def jobs_frame(settings: Settings, view: str = "All", limit: int = 500) -> pd.DataFrame:
    states = {
        "Active": ACTIVE_STATES,
        "Pending": ("PENDING",),
        "Running": ("RUNNING",),
        "Finished": FINISHED_STATES,
    }.get(view)
    sql = "SELECT * FROM jobs"
    params: tuple = ()
    if states:
        sql += f" WHERE state IN ({','.join('?' * len(states))})"
        params = states
    sql += " ORDER BY CASE state WHEN 'RUNNING' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END, priority DESC, id DESC LIMIT ?"
    with session(settings) as conn:
        df = pd.read_sql_query(sql, conn, params=(*params, limit))
    now = time.time()
    if df.empty:
        return df.assign(wait_s=[], run_s=[], time_used=[], submitted=[], started=[], finished=[], time_limit_min=[])
    ends = df["end_time"].fillna(now)
    df["wait_s"] = (df["start_time"].fillna(ends) - df["submit_time"]).clip(lower=0)
    df["run_s"] = (ends - df["start_time"]).where(df["start_time"].notna())
    df["time_used"] = (df["run_s"] / df["time_limit_s"]).clip(upper=1.0)
    df["submitted"] = _local(df["submit_time"])
    df["started"] = _local(df["start_time"])
    df["finished"] = _local(df["end_time"])
    df["time_limit_min"] = df["time_limit_s"] / 60
    return df


def nodes_frame(settings: Settings) -> pd.DataFrame:
    with session(settings) as conn:
        nodes = pd.read_sql_query("SELECT * FROM nodes ORDER BY partition, name", conn)
        load = pd.read_sql_query(
            "SELECT node AS name, COUNT(*) AS jobs, SUM(cpus) AS used_cpus, SUM(memory_gb) AS used_memory_gb, "
            "SUM(gpus) AS used_gpus FROM jobs WHERE state = 'RUNNING' GROUP BY node",
            conn,
        )
    df = nodes.merge(load, on="name", how="left").fillna({"jobs": 0, "used_cpus": 0, "used_memory_gb": 0, "used_gpus": 0})
    for col in ("jobs", "used_cpus", "used_memory_gb", "used_gpus"):
        df[col] = df[col].astype(int)
    df["gpu_alloc"] = (df["used_gpus"] / df["gpus"].where(df["gpus"] > 0)).fillna(0.0)
    df["cpu_alloc"] = df["used_cpus"] / df["cpus"]

    def status(row) -> str:
        if row["state"] == "down":
            return "down"
        if row["state"] == "drain":
            return "draining" if row["jobs"] else "drained"
        if row["jobs"] == 0:
            return "idle"
        full = (row["gpus"] and row["used_gpus"] >= row["gpus"]) or row["used_cpus"] >= row["cpus"]
        return "allocated" if full else "mixed"

    df["status"] = df.apply(status, axis=1) if not df.empty else []
    return df


def summary(settings: Settings) -> dict:
    nodes = nodes_frame(settings)
    with session(settings) as conn:
        counts = dict(conn.execute("SELECT state, COUNT(*) FROM jobs GROUP BY state").fetchall())
        since = time.time() - 86400
        done_today = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE state = 'COMPLETED' AND end_time > ?", (since,)
        ).fetchone()[0]
    up = nodes[nodes["state"] == "up"]
    return {
        "running": counts.get("RUNNING", 0),
        "pending": counts.get("PENDING", 0),
        "completed_24h": done_today,
        "gpus_alloc": int(nodes["used_gpus"].sum()),
        "gpus_total": int(nodes["gpus"].sum()),
        "cpus_alloc": int(nodes["used_cpus"].sum()),
        "cpus_total": int(nodes["cpus"].sum()),
        "nodes_up": len(up),
        "nodes_total": len(nodes),
    }


def snapshots_frame(settings: Settings, minutes: int = 30) -> pd.DataFrame:
    with session(settings) as conn:
        df = pd.read_sql_query(
            "SELECT * FROM snapshots WHERE ts > ? ORDER BY ts", conn, params=(time.time() - minutes * 60,)
        )
    df["time"] = _local(df["ts"])
    df["GPU %"] = (100 * df["gpus_alloc"] / df["gpus_total"].where(df["gpus_total"] > 0)).fillna(0).round(1)
    df["CPU %"] = (100 * df["cpus_alloc"] / df["cpus_total"].where(df["cpus_total"] > 0)).fillna(0).round(1)
    return df.rename(columns={"running": "Running", "pending": "Pending", "nodes_up": "Nodes up"})


def _usage_rows(settings: Settings) -> list[dict]:
    with session(settings) as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT user, account, cpus, gpus, state, start_time, end_time FROM jobs "
                "WHERE start_time IS NOT NULL AND start_time > ?",
                (time.time() - 30 * 86400,),
            )
        ]


def usage_by_account(settings: Settings) -> pd.DataFrame:
    now = time.time()
    rows = _usage_rows(settings)
    decayed = decayed_usage(rows, now, settings)
    total_shares = sum(settings.account_shares.values()) or 1
    total_usage = sum(decayed.values())
    records = []
    for account, shares in settings.account_shares.items():
        mine = [r for r in rows if r["account"] == account]
        gpu_h = sum(((r["end_time"] or now) - r["start_time"]) * r["gpus"] for r in mine) / 3600
        cpu_h = sum(((r["end_time"] or now) - r["start_time"]) * r["cpus"] for r in mine) / 3600
        records.append(
            {
                "account": account,
                "jobs": len(mine),
                "gpu_hours": round(gpu_h, 3),
                "cpu_hours": round(cpu_h, 3),
                "target_share": shares / total_shares,
                "recent_usage": (decayed.get(account, 0.0) / total_usage) if total_usage else 0.0,
                "fairshare": round(fairshare_factor(account, decayed, settings.account_shares), 3),
            }
        )
    return pd.DataFrame(records)


def usage_by_user(settings: Settings) -> pd.DataFrame:
    now = time.time()
    rows = _usage_rows(settings)
    if not rows:
        return pd.DataFrame(columns=["user", "account", "jobs", "completed", "failed", "gpu_hours", "cpu_hours"])
    df = pd.DataFrame(rows)
    df["run_s"] = df["end_time"].fillna(now) - df["start_time"]
    df["gpu_hours"] = df["run_s"] * df["gpus"] / 3600
    df["cpu_hours"] = df["run_s"] * df["cpus"] / 3600
    out = df.groupby(["user", "account"]).agg(
        jobs=("state", "size"),
        completed=("state", lambda s: int((s == "COMPLETED").sum())),
        failed=("state", lambda s: int(s.isin(["FAILED", "TIMEOUT"]).sum())),
        gpu_hours=("gpu_hours", "sum"),
        cpu_hours=("cpu_hours", "sum"),
    )
    return out.reset_index().round({"gpu_hours": 3, "cpu_hours": 3}).sort_values("gpu_hours", ascending=False)


def job_outcomes(settings: Settings) -> pd.DataFrame:
    with session(settings) as conn:
        return pd.read_sql_query("SELECT state, COUNT(*) AS jobs FROM jobs GROUP BY state ORDER BY jobs DESC", conn)


def events_frame(settings: Settings, limit: int = 300, levels: list[str] | None = None) -> pd.DataFrame:
    sql = "SELECT * FROM events"
    params: list = []
    if levels:
        sql += f" WHERE level IN ({','.join('?' * len(levels))})"
        params = list(levels)
    with session(settings) as conn:
        df = pd.read_sql_query(sql + " ORDER BY id DESC LIMIT ?", conn, params=(*params, limit))
    df["time"] = _local(df["ts"])
    return df


def emails_frame(settings: Settings, limit: int = 300) -> pd.DataFrame:
    with session(settings) as conn:
        df = pd.read_sql_query("SELECT * FROM emails ORDER BY id DESC LIMIT ?", conn, params=(limit,))
    df["time"] = _local(df["ts"])
    return df


def job_ids(settings: Settings, states: tuple[str, ...] | None = None, limit: int = 300) -> list[int]:
    sql = "SELECT id FROM jobs"
    params: tuple = ()
    if states:
        sql += f" WHERE state IN ({','.join('?' * len(states))})"
        params = states
    with session(settings) as conn:
        return [r[0] for r in conn.execute(sql + " ORDER BY id DESC LIMIT ?", (*params, limit))]


def tail_output(settings: Settings, job_id: int, lines: int = 40) -> str:
    with session(settings) as conn:
        row = conn.execute("SELECT workdir, state, reason FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        return f"Job {job_id} does not exist."
    if not row["workdir"]:
        return f"Job {job_id} has not started yet ({row['state']}: {row['reason']})."
    path = Path(row["workdir"]) / "output.log"
    if not path.exists():
        return "No output yet."
    text = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(text[-lines:])


def scheduler_alive(settings: Settings, max_age_s: float = 15) -> tuple[bool, float | None]:
    with session(settings) as conn:
        beat = get_meta(conn, "scheduler_heartbeat")
    if beat is None:
        return False, None
    age = time.time() - float(beat)
    return age <= max_age_s, age


def maintenance_status(settings: Settings) -> dict[str, float | None]:
    with session(settings) as conn:
        return {
            key: (float(v) if (v := get_meta(conn, key)) else None)
            for key in ("scheduler_heartbeat", "last_backup", "last_report", "last_purge")
        }
