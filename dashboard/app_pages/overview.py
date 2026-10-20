import streamlit as st

from hpc_autopilot import queries, ui

settings = ui.get_settings()

NODE_COLUMNS = {
    "name": st.column_config.TextColumn("Node"),
    "partition": st.column_config.TextColumn("Partition"),
    "status": st.column_config.TextColumn("Status"),
    "gpu_type": st.column_config.TextColumn("GPU type"),
    "gpu_alloc": st.column_config.ProgressColumn("GPUs in use", min_value=0.0, max_value=1.0, format="percent"),
    "cpu_alloc": st.column_config.ProgressColumn("CPUs in use", min_value=0.0, max_value=1.0, format="percent"),
    "gpu_temp_c": st.column_config.NumberColumn("GPU temp (C)", format="%.0f"),
    "jobs": st.column_config.NumberColumn("Jobs"),
    "reason": st.column_config.TextColumn("Reason"),
}


@st.fragment(run_every="3s")
def live_overview():
    summary = queries.summary(settings)
    snaps = queries.snapshots_frame(settings, minutes=30)

    def trend(column: str) -> list | None:
        return snaps[column].tail(60).tolist() if len(snaps) > 1 else None

    with st.container(horizontal=True):
        st.metric("Running jobs", summary["running"], border=True, chart_data=trend("Running"))
        st.metric("Waiting in queue", summary["pending"], border=True, chart_data=trend("Pending"))
        st.metric("GPUs in use", f"{summary['gpus_alloc']} / {summary['gpus_total']}", border=True, chart_data=trend("GPU %"))
        st.metric("CPU cores in use", f"{summary['cpus_alloc']} / {summary['cpus_total']}", border=True, chart_data=trend("CPU %"))
        st.metric("Nodes accepting jobs", f"{summary['nodes_up']} / {summary['nodes_total']}", border=True, chart_data=trend("Nodes up"))

    left, right = st.columns(2)
    with left, st.container(border=True):
        st.subheader("Allocation, last 30 minutes")
        if len(snaps) > 1:
            st.line_chart(snaps, x="time", y=["GPU %", "CPU %"], x_label="", y_label="Allocated (%)",
                          alt="GPU and CPU allocation over the last 30 minutes")
        else:
            st.caption("History appears once the scheduler has been running for a few seconds.")
    with right, st.container(border=True):
        st.subheader("Jobs, last 30 minutes")
        if len(snaps) > 1:
            st.line_chart(snaps, x="time", y=["Running", "Pending"], x_label="", y_label="Jobs",
                          alt="Running and pending jobs over the last 30 minutes")
        else:
            st.caption("History appears once the scheduler has been running for a few seconds.")

    with st.container(border=True):
        st.subheader("Nodes")
        nodes = queries.nodes_frame(settings)
        st.dataframe(nodes[list(NODE_COLUMNS)], hide_index=True, column_config=NODE_COLUMNS, alt="Node status")

    with st.container(border=True):
        st.subheader("Latest automated actions")
        events = queries.events_frame(settings, limit=8)
        st.dataframe(
            events[["time", "level", "category", "message"]],
            hide_index=True,
            column_config={"time": st.column_config.DatetimeColumn("Time", format="HH:mm:ss")},
            alt="Latest scheduler and health events",
        )


live_overview()
