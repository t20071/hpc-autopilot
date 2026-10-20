import time

from hpc_autopilot import admin, jobs
from hpc_autopilot.db import session
from hpc_autopilot.notify import notify_finished_jobs
from hpc_autopilot.service import Autopilot, SchedulerAlreadyRunning


def request(**kw):
    base = dict(name="demo", user="prof_mehta", email="mehta@faculty.example.edu", role="faculty", account="research",
                partition="gpu", cpus=2, memory_gb=4, gpus=1, time_limit_minutes=2,
                command="python jobs/train_model.py --epochs 2 --seconds-per-epoch 0.2")
    return jobs.JobRequest(**{**base, **kw})


def job(settings, job_id):
    with session(settings) as conn:
        return dict(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())


def test_submit_queue_run_and_email(settings):
    ok = jobs.submit(settings, request())
    bad = jobs.submit(settings, request(name="crash", command="python jobs/train_model.py --epochs 3 --seconds-per-epoch 0.1 --fail-at 2"))
    slow = jobs.submit(settings, request(name="slow", time_limit_minutes=0.02, command="python jobs/train_model.py --epochs 50 --seconds-per-epoch 1"))
    assert job(settings, ok)["state"] == "PENDING"

    Autopilot(settings).run_until_idle(timeout_s=120)

    assert job(settings, ok)["state"] == "COMPLETED"
    assert job(settings, bad)["state"] == "FAILED"
    assert job(settings, slow)["state"] == "TIMEOUT"
    assert all(job(settings, i)["notified"] == 1 for i in (ok, bad, slow))
    emails = list(settings.outbox_dir.glob("*.eml"))
    assert len(emails) == 3
    assert any("Your job is completed." in e.read_text(encoding="utf-8") for e in emails)


def test_bad_email_row_does_not_block_others(settings):
    good = jobs.submit(settings, request())
    with session(settings) as conn:
        # simulate a row that slipped in before validation existed
        conn.execute("UPDATE jobs SET state = 'COMPLETED', end_time = 1 WHERE id = ?", (good,))
        conn.execute(
            "INSERT INTO jobs (name, user, email, role, account, partition, cpus, memory_gb, gpus, time_limit_s, "
            "command, state, submit_time, end_time) VALUES ('x\ny', 'u', 'u@x.edu', 'phd', 'research', 'gpu', 1, 1, 0, 60, "
            "'python jobs/data_prep.py', 'COMPLETED', 0, 1)"
        )
        notify_finished_jobs(conn, settings)
    assert job(settings, good)["notified"] == 1


def test_fault_drains_requeues_and_resumes(settings):
    job_id = jobs.submit(settings, request(command="python jobs/train_model.py --epochs 30 --seconds-per-epoch 1"))
    pilot = Autopilot(settings, seed=1)
    pilot.startup(check_running=False)
    try:
        pilot.tick()
        node = job(settings, job_id)["node"]
        admin.set_fault(settings, node, "node_down")
        pilot.tick()
        assert job(settings, job_id)["state"] in ("PENDING", "RUNNING")
        assert job(settings, job_id)["node"] != node
        admin.set_fault(settings, node, "")
        pilot.tick()
        with session(settings) as conn:
            assert conn.execute("SELECT state FROM nodes WHERE name = ?", (node,)).fetchone()[0] == "up"
    finally:
        pilot.shutdown()


def test_cancel_pending_job(settings):
    job_id = jobs.submit(settings, request())
    jobs.cancel(settings, job_id)
    assert job(settings, job_id)["state"] == "CANCELLED"


def test_restart_requeues_running_jobs_and_honours_cancel(settings):
    keep = jobs.submit(settings, request())
    stop = jobs.submit(settings, request(name="stop-me"))
    with session(settings) as conn:
        conn.execute("UPDATE jobs SET state = 'RUNNING', node = 'gpu01', start_time = ?, pid = NULL", (time.time(),))
        conn.execute("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", (stop,))
    pilot = Autopilot(settings)
    pilot.startup(check_running=False)
    pilot.shutdown()
    assert job(settings, keep)["state"] == "PENDING"
    assert job(settings, stop)["state"] == "CANCELLED"


def test_only_one_scheduler_at_a_time(settings):
    first = Autopilot(settings)
    first.startup()
    try:
        second = Autopilot(settings)
        try:
            second.startup()
        except SchedulerAlreadyRunning:
            pass
        else:
            second.shutdown()
            raise AssertionError("second scheduler started")
    finally:
        first.shutdown()


def test_smtp_outage_never_blocks_the_scheduler(settings):
    import dataclasses

    from hpc_autopilot.notify import deliver_queued

    smtp = dataclasses.replace(settings, email_mode="smtp", smtp_host="127.0.0.1", smtp_port=1, smtp_starttls=False)
    job_id = jobs.submit(smtp, request())
    with session(smtp) as conn:
        conn.execute("UPDATE jobs SET state = 'COMPLETED', end_time = 1 WHERE id = ?", (job_id,))
        started = time.time()
        notify_finished_jobs(conn, smtp)
        assert time.time() - started < 1  # only queued; nothing waits on the mail server
    assert job(smtp, job_id)["notified"] == 1
    assert deliver_queued(smtp) == 0  # server unreachable
    with session(smtp) as conn:
        row = conn.execute("SELECT status, attempts, next_try FROM emails").fetchone()
    assert row["status"] == "queued" and row["attempts"] == 1 and row["next_try"] > time.time()
