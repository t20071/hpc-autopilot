import streamlit as st

from hpc_autopilot import queries, ui

st.set_page_config(page_title="HPC Autopilot", page_icon=":material/memory:", layout="wide")

settings = ui.get_settings()

page = st.navigation(
    [
        st.Page("app_pages/overview.py", title="Overview", icon=":material/dashboard:", default=True),
        st.Page("app_pages/submit.py", title="Submit job", icon=":material/send:"),
        st.Page("app_pages/queue.py", title="Queue", icon=":material/list_alt:"),
        st.Page("app_pages/nodes.py", title="Nodes", icon=":material/dns:"),
        st.Page("app_pages/accounting.py", title="Accounting", icon=":material/pie_chart:"),
        st.Page("app_pages/notifications.py", title="Notifications", icon=":material/mail:"),
        st.Page("app_pages/automation.py", title="Automation", icon=":material/smart_toy:"),
    ],
    position="top",
)


@st.fragment(run_every="5s")
def scheduler_status():
    alive, _ = queries.scheduler_alive(settings)
    if not alive:
        st.warning(
            "Jobs wait in the queue until it runs. Start it in a terminal with `uv run hpc scheduler`, "
            "or start everything with `uv run hpc up`.",
            title="The scheduler is not running",
            icon=":material/warning:",
        )


st.title(page.title, icon=page.icon)
scheduler_status()
page.run()
