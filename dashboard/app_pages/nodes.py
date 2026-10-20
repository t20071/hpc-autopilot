import streamlit as st

from hpc_autopilot import admin, queries, ui
from hpc_autopilot.health import FAULTS

settings = ui.get_settings()

COLUMNS = {
    "name": st.column_config.TextColumn("Node"),
    "partition": st.column_config.TextColumn("Partition"),
    "status": st.column_config.TextColumn("Status"),
    "gpu_type": st.column_config.TextColumn("GPU type"),
    "used_gpus": st.column_config.NumberColumn("GPUs used"),
    "gpus": st.column_config.NumberColumn("GPUs"),
    "used_cpus": st.column_config.NumberColumn("CPUs used"),
    "cpus": st.column_config.NumberColumn("CPUs"),
    "used_memory_gb": st.column_config.NumberColumn("Memory used (GB)"),
    "memory_gb": st.column_config.NumberColumn("Memory (GB)"),
    "gpu_temp_c": st.column_config.NumberColumn("GPU temp (C)", format="%.0f"),
    "fault": st.column_config.TextColumn("Injected fault"),
    "reason": st.column_config.TextColumn("Reason"),
}


@st.fragment(run_every="3s")
def node_table():
    nodes = queries.nodes_frame(settings)
    st.dataframe(nodes[list(COLUMNS)], hide_index=True, column_config=COLUMNS, alt="Node details")
    hot = nodes[nodes["gpus"] > 0]
    if not hot.empty:
        st.bar_chart(hot, x="name", y="gpu_temp_c", x_label="", y_label="GPU temperature (C)",
                     alt="GPU temperature per node")


node_table()

ACTIONS = {
    "Drain": lambda node, reason: admin.drain_node(settings, node, reason),
    "Resume": lambda node, reason: admin.resume_node(settings, node),
    "Simulate GPU overheating": lambda node, reason: admin.set_fault(settings, node, "gpu_overheat"),
    "Simulate ECC error": lambda node, reason: admin.set_fault(settings, node, "ecc_error"),
    "Simulate node failure": lambda node, reason: admin.set_fault(settings, node, "node_down"),
    "Clear fault": lambda node, reason: admin.set_fault(settings, node, ""),
}

with st.container(border=True):
    st.subheader("Admin actions")
    st.caption(
        "Drain stops new jobs landing on a node while running jobs finish. The simulated faults are drills: "
        f"the health check drains a faulty node, alerts the admin, requeues jobs from a failed node, and "
        f"resumes the node once the fault clears. Faults available: {', '.join(FAULTS.values()).lower()}."
    )
    with st.form("node_action"):
        c1, c2 = st.columns([1, 3])
        node = c1.selectbox("Node", [n.name for n in settings.nodes])
        action = c2.segmented_control("Action", list(ACTIONS), default="Drain", required=True)
        reason = st.text_input("Reason (for drain)", value="Planned maintenance")
        if st.form_submit_button("Apply", type="primary", icon=":material/build:"):
            st.success(ACTIONS[action](node, reason), icon=":material/check_circle:")
