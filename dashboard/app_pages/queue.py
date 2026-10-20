import streamlit as st

from hpc_autopilot import jobs, queries, ui

settings = ui.get_settings()

JOB_COLUMNS = {
    "id": st.column_config.NumberColumn("Job", format="%d"),
    "name": st.column_config.TextColumn("Name"),
    "user": st.column_config.TextColumn("User"),
    "role": st.column_config.TextColumn("Role"),
    "account": st.column_config.TextColumn("Account"),
    "state": st.column_config.TextColumn("State"),
    "reason": st.column_config.TextColumn("Reason", help="Why a job is waiting, or how it ended"),
    "priority": st.column_config.NumberColumn("Priority", format="%.0f"),
    "node": st.column_config.TextColumn("Node"),
    "gpus": st.column_config.NumberColumn("GPUs"),
    "time_used": st.column_config.ProgressColumn("Time limit used", min_value=0.0, max_value=1.0, format="percent"),
    "submitted": st.column_config.DatetimeColumn("Submitted", format="HH:mm:ss"),
    "finished": st.column_config.DatetimeColumn("Finished", format="HH:mm:ss"),
}

view = st.segmented_control(
    "Show", ["Active", "Pending", "Running", "Finished", "All"], default="Active", required=True, key="queue_view"
)


@st.fragment(run_every="3s")
def job_table(view: str):
    df = queries.jobs_frame(settings, view=view)
    if df.empty:
        st.info("No jobs here yet. Submit one on the Submit job page.", icon=":material/inbox:")
        return
    st.dataframe(df[list(JOB_COLUMNS)], hide_index=True, column_config=JOB_COLUMNS, alt=f"{view} jobs")


job_table(view)

left, right = st.columns([1, 2])
with left, st.container(border=True):
    st.subheader("Cancel a job")
    active = queries.job_ids(settings, states=("PENDING", "RUNNING"))
    with st.container(horizontal=True, vertical_alignment="bottom"):
        job_id = st.selectbox("Active job", active, key="cancel_job", placeholder="No active jobs")
        if st.button("Cancel", icon=":material/cancel:", disabled=not active):
            try:
                st.toast(jobs.cancel(settings, int(job_id)), icon=":material/cancel:")
            except ValueError as exc:
                st.error(str(exc), icon=":material/error:")

with right, st.container(border=True):
    st.subheader("Job output")
    recent = queries.job_ids(settings)
    log_job = st.selectbox("Job", recent, key="log_job", placeholder="No jobs yet")

    @st.fragment(run_every="3s")
    def output(job_id):
        if job_id is not None:
            st.code(queries.tail_output(settings, int(job_id)), language=None, height=300)

    output(log_job)
