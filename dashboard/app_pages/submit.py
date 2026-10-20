import pandas as pd
import streamlit as st

from hpc_autopilot import demo, jobs, uploads, ui

settings = ui.get_settings()

st.caption(
    "This page plays the role of `sbatch` on a real cluster. Upload your code (or pick a sample), "
    "submit it, and it waits in the queue until a node is free, runs there, and you get an email when it finishes."
)

# ---------------------------------------------------------------- upload
with st.container(border=True):
    st.subheader("Upload your script", anchor=False)
    st.caption(
        "A single `.py` file, or a `.zip` of a whole project (its folders are kept and it runs from its own folder, "
        "so relative paths like `data/train.csv` work). Files are stored in `jobs/uploads/<username>/`. "
        "Write results to the folder in the `HPC_JOB_DIR` environment variable."
    )
    with st.form("upload", clear_on_submit=True):
        c1, c2 = st.columns([1, 3])
        owner = c1.text_input("Your username", value=st.session_state.get("upload_user", "asha"), max_chars=32)
        file = c2.file_uploader("Script or project", type=["py", "zip"], accept_multiple_files=False)
        if st.form_submit_button("Upload", icon=":material/upload:", type="primary"):
            if file is None:
                st.warning("Choose a .py or .zip file first.", icon=":material/warning:")
            else:
                try:
                    if file.name.lower().endswith(".zip"):
                        project, entries = uploads.save_project(settings, owner.strip(), file.name, file.getvalue())
                        picked = entries[0]
                        st.success(
                            f"Project unpacked to `{project.relative_to(settings.home).as_posix()}` with "
                            f"{len(entries)} runnable script(s). Pick the one to run in the form below.",
                            icon=":material/check_circle:",
                        )
                    else:
                        picked = uploads.save_script(settings, owner.strip(), file.name, file.getvalue())
                        st.success(f"Saved as `{picked.relative_to(settings.home).as_posix()}`.", icon=":material/check_circle:")
                    st.session_state.upload_user = owner.strip()
                    st.session_state.workload = f"python {picked.relative_to(settings.home).as_posix()}"
                except ValueError as exc:
                    st.error(str(exc), icon=":material/error:")

    mine = uploads.list_uploads(settings)
    if mine:
        with st.expander(f"Uploaded files ({len(mine)})", icon=":material/folder:"):
            df = pd.DataFrame(mine)
            df["uploaded"] = pd.to_datetime(df["uploaded"], unit="s", utc=True).dt.tz_convert(None)
            st.dataframe(
                df[["user", "kind", "script", "size_kb", "uploaded"]],
                hide_index=True,
                column_config={
                    "size_kb": st.column_config.NumberColumn("Size (KB)", format="%.1f"),
                    "uploaded": st.column_config.DatetimeColumn("Uploaded", format="YYYY-MM-DD HH:mm"),
                },
                alt="Uploaded scripts and projects",
            )
            items = sorted({(r["user"], r["item"]) for r in mine})
            with st.container(horizontal=True, vertical_alignment="bottom"):
                choice = st.selectbox("Remove an upload", items, format_func=lambda x: f"{x[0]} / {x[1]}")
                if st.button("Delete", icon=":material/delete:"):
                    uploads.delete_upload(settings, *choice)
                    st.rerun()

# ---------------------------------------------------------------- submit
templates = dict(jobs.list_templates(settings))
for row in uploads.list_uploads(settings):
    templates[row["command"]] = f"uploaded by {row['user']}"
options = list(templates)
default = st.session_state.get("workload")
index = options.index(default) if default in options else next((i for i, t in enumerate(options) if "train_model" in t), 0)
example_args = {
    "python jobs/train_model.py": "--epochs 8 --seconds-per-epoch 2",
    "python jobs/monte_carlo_pi.py": "--samples 3000000",
    "python jobs/data_prep.py": "--rows 200000",
}

with st.form("submit_job"):
    c1, c2, c3 = st.columns(3)
    name = c1.text_input("Job name", value="my-experiment", max_chars=60, required=True)
    user = c2.text_input("Username", value=st.session_state.get("upload_user", "asha"), max_chars=32, required=True)
    email = c3.text_input("Email for notifications", value="asha@students.example.edu", type="email", required=True)

    c1, c2, c3 = st.columns(3)
    with c1:
        role = st.segmented_control("Role", list(settings.qos), default="student", required=True, format_func=str.capitalize)
    with c2:
        account = st.selectbox("Account", list(settings.account_shares))
    with c3:
        partition = st.segmented_control("Partition", settings.partitions, default=settings.partitions[-1], required=True)

    c1, c2, c3, c4 = st.columns(4)
    cpus = c1.number_input("CPU cores", min_value=1, max_value=64, value=4, step=1)
    memory_gb = c2.number_input("Memory (GB)", min_value=1, max_value=512, value=16, step=1)
    gpus = c3.number_input("GPUs", min_value=0, max_value=4, value=1, step=1)
    minutes = c4.number_input("Time limit (minutes)", min_value=1, max_value=240, value=10, step=1)

    template = st.selectbox(
        "Workload",
        options,
        index=index,
        format_func=lambda t: f"{t}  ({templates[t]})" if templates[t] else t,
        help="Sample workloads, plus anything you uploaded above.",
    )
    args = st.text_input("Arguments", placeholder=" | ".join(f"{k.split('/')[-1]}: {v}" for k, v in example_args.items()))
    custom = ""
    if settings.allow_custom_commands:
        custom = st.text_input("Custom command (overrides the workload)", placeholder="python my_script.py --flag")
    notify = st.toggle("Email me when the job finishes", value=True)
    submitted = st.form_submit_button("Submit job", type="primary", icon=":material/send:")

if submitted:
    request = jobs.JobRequest(
        name=name, user=user, email=email, role=role, account=account, partition=partition,
        cpus=int(cpus), memory_gb=int(memory_gb), gpus=int(gpus), time_limit_minutes=float(minutes),
        command=custom.strip() or f"{template} {args}".strip(), mail_type="END" if notify else "NONE",
    )
    try:
        job_id = jobs.submit(settings, request)
    except ValueError as exc:
        st.error(str(exc), title="The job was not submitted", icon=":material/error:")
    else:
        st.success(f"Submitted batch job {job_id}. Follow it on the Queue page.", title="Job queued", icon=":material/check_circle:")
        st.toast(f"Job {job_id} queued", icon=":material/send:")

with st.container(border=True):
    st.subheader("Limits by role")
    limits = pd.DataFrame(
        [
            {"Role": q.name.capitalize(), "Priority bonus": q.priority, "Max GPUs at a time": q.max_gpus_per_user,
             "Max running jobs": q.max_running_jobs, "Max time (min)": q.max_time_minutes}
            for q in settings.qos.values()
        ]
    )
    st.table(limits, hide_index=True, alt="Quality-of-service limits for each role")

with st.container(border=True):
    st.subheader("Try it quickly")
    st.caption("Submit ten sample jobs from students, PhD scholars, faculty and a startup, including one that fails and one that runs out of time.")
    if st.button("Submit the demo batch", icon=":material/rocket_launch:"):
        ids = demo.submit_demo_batch(settings)
        st.success(f"Submitted jobs {', '.join(map(str, ids))}.", title="Demo batch queued", icon=":material/check_circle:")
