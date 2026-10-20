import streamlit as st

from hpc_autopilot import queries, ui

settings = ui.get_settings()

if settings.email_mode == "smtp":
    st.info(f"Emails are sent through {settings.smtp_host}:{settings.smtp_port}.", icon=":material/mail:")
else:
    st.info(
        f"Emails are saved as .eml files in `{settings.outbox_dir}` (open them with any mail app). "
        "Set `mode = \"smtp\"` in cluster.toml to send real email.",
        icon=":material/outbox:",
    )

emails = queries.emails_frame(settings)
if emails.empty:
    st.caption("No emails yet. Users are emailed when their jobs finish; the admin is emailed when a node is drained or resumed.")
else:
    st.dataframe(
        emails[["time", "to_addr", "subject", "status"]],
        hide_index=True,
        column_config={
            "time": st.column_config.DatetimeColumn("Time", format="YYYY-MM-DD HH:mm:ss"),
            "to_addr": st.column_config.TextColumn("To"),
            "subject": st.column_config.TextColumn("Subject"),
            "status": st.column_config.TextColumn("Status"),
        },
        alt="Notification emails",
    )
    with st.container(border=True):
        options = emails["id"].tolist()
        chosen = st.selectbox(
            "Read an email",
            options,
            format_func=lambda i: emails.set_index("id").loc[i, "subject"],
        )
        row = emails.set_index("id").loc[chosen]
        st.caption(f"To {row['to_addr']} at {row['time']:%Y-%m-%d %H:%M:%S}")
        st.code(row["body"], language=None)
