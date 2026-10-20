import streamlit as st

from hpc_autopilot import queries, ui

settings = ui.get_settings()

st.caption(
    "Fair-share keeps each account close to its target share. An account that has used more than its "
    "share recently gets a lower fair-share factor, so its waiting jobs drop in priority."
)


@st.fragment(run_every="5s")
def accounts():
    df = queries.usage_by_account(settings)
    left, right = st.columns([3, 2])
    with left, st.container(border=True):
        st.subheader("Accounts")
        st.dataframe(
            df,
            hide_index=True,
            column_config={
                "account": st.column_config.TextColumn("Account"),
                "jobs": st.column_config.NumberColumn("Jobs"),
                "gpu_hours": st.column_config.NumberColumn("GPU hours", format="%.3f"),
                "cpu_hours": st.column_config.NumberColumn("CPU hours", format="%.3f"),
                "target_share": st.column_config.ProgressColumn("Target share", min_value=0.0, max_value=1.0, format="percent"),
                "recent_usage": st.column_config.ProgressColumn("Recent usage", min_value=0.0, max_value=1.0, format="percent"),
                "fairshare": st.column_config.NumberColumn("Fair-share factor", format="%.2f",
                                                           help="1.0 = unused, 0.5 = used exactly its share"),
            },
            alt="Usage and fair-share by account",
        )
    with right, st.container(border=True):
        st.subheader("GPU hours by account")
        st.bar_chart(df, x="account", y="gpu_hours", x_label="", y_label="GPU hours", alt="GPU hours by account")


accounts()

users = queries.usage_by_user(settings)
outcomes = queries.job_outcomes(settings)
left, right = st.columns([3, 2])
with left, st.container(border=True):
    st.subheader("Users")
    st.dataframe(users, hide_index=True, alt="Usage by user")
    st.download_button(
        "Download usage report (CSV)", users.to_csv(index=False), file_name="usage_by_user.csv",
        mime="text/csv", icon=":material/download:",
    )
with right, st.container(border=True):
    st.subheader("Job outcomes")
    if outcomes.empty:
        st.caption("No jobs yet.")
    else:
        st.bar_chart(outcomes, x="state", y="jobs", x_label="", y_label="Jobs", alt="Number of jobs by final state")
