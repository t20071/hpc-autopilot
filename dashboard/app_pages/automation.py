import pandas as pd
import streamlit as st

from hpc_autopilot import maintenance, queries, ui
from hpc_autopilot.db import log_event, session

settings = ui.get_settings()
status = queries.maintenance_status(settings)
tick = f"every {settings.tick_seconds:g}s"

st.caption("Every task below runs on its own once the scheduler is started. The admin only watches and steps in when alerted.")

automation = pd.DataFrame(
    [
        ("Queue, prioritise and schedule jobs onto free nodes", "Fair-share + age + role priority, per-role limits, backfill", tick, ui.ago(status["scheduler_heartbeat"])),
        ("Run jobs and enforce limits", "Start processes with assigned GPUs, stop jobs at their time limit, honour cancellations", tick, ui.ago(status["scheduler_heartbeat"])),
        ("Email users when jobs finish", "Completed, failed, timed-out and cancelled notices", tick, ui.ago(status["scheduler_heartbeat"])),
        ("Monitor node health and GPU utilisation", "GPU temperature, ECC errors, heartbeat; utilisation history", tick, ui.ago(status["scheduler_heartbeat"])),
        ("Troubleshoot hardware faults", "Drain faulty nodes, requeue jobs from failed nodes, alert admin, auto-resume", tick, ui.ago(status["scheduler_heartbeat"])),
        ("Back up the job database", f"Online SQLite backup, keep last {settings.backup_keep}", f"every {settings.backup_every_minutes:g} min", ui.ago(status["last_backup"])),
        ("Report utilisation", "Usage CSV per user and account", f"every {settings.report_every_minutes:g} min", ui.ago(status["last_report"])),
        ("Clean up old job output", f"Delete outputs older than {settings.purge_after_days:g} days", "daily", ui.ago(status["last_purge"])),
        ("Access control", "Registered users fixed to their role and account ([users] in cluster.toml), role limits, script allow-list, localhost-only dashboard, audit log", "always", "-"),
    ],
    columns=["Job-description task", "How it is automated", "Runs", "Last run"],
)
st.table(automation, hide_index=True, alt="Automated tasks and when they last ran")

with st.container(horizontal=True):
    if st.button("Back up now", icon=":material/backup:"):
        path = maintenance.backup_database(settings)
        with session(settings) as conn:
            log_event(conn, "info", "maintenance", f"Manual backup written to {path.name}")
        st.toast(f"Backup written to {path.name}", icon=":material/backup:")
    if st.button("Write usage report now", icon=":material/summarize:"):
        path = maintenance.usage_report(settings)
        with session(settings) as conn:
            log_event(conn, "info", "maintenance", f"Manual usage report written to {path.name}")
        st.toast(f"Report written to {path.name}", icon=":material/summarize:")

levels = st.pills("Event levels", ["info", "warning", "error"], selection_mode="multi", default=["info", "warning", "error"])


@st.fragment(run_every="3s")
def event_log(levels: list[str]):
    events = queries.events_frame(settings, levels=levels or None)
    st.dataframe(
        events[["time", "level", "category", "message"]],
        hide_index=True,
        column_config={"time": st.column_config.DatetimeColumn("Time", format="YYYY-MM-DD HH:mm:ss")},
        alt="Audit log of automated and admin actions",
    )


event_log(levels)
