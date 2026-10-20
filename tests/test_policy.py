from hpc_autopilot.policy import NodeState, PendingJob, RunningJob, fairshare_factor, plan_schedule


def node(name="gpu01", gpus=4, cpus=32, mem=256, available=True):
    return NodeState(name, "gpu", cpus, mem, gpus, available=available)


def pending(job_id, user="u", role="faculty", gpus=1, minutes=10, submitted=0.0, account="research"):
    return PendingJob(job_id, user, role, account, "gpu", 4, 16, gpus, minutes * 60, submitted)


def test_fairshare_prefers_light_users():
    usage = {"research": 90.0, "teaching": 10.0}
    shares = {"research": 50, "teaching": 50}
    assert fairshare_factor("teaching", usage, shares) > fairshare_factor("research", usage, shares)


def test_role_priority_orders_the_queue(settings):
    jobs = [pending(1, user="s", role="student", account="teaching"), pending(2, user="f", role="faculty")]
    plan = plan_schedule(jobs, [node(gpus=1)], [], 0.0, settings, {})
    assert [j for j, _ in plan.starts] == [2]
    assert plan.priorities[2] > plan.priorities[1]


def test_student_gpu_limit_holds_second_job(settings):
    jobs = [pending(1, user="asha", role="student", account="teaching"), pending(2, user="asha", role="student", account="teaching")]
    plan = plan_schedule(jobs, [node()], [], 0.0, settings, {})
    assert [j for j, _ in plan.starts] == [1]
    assert plan.reasons[2].startswith("QOS")


def test_backfill_only_when_it_ends_before_the_reservation(settings):
    n = node()
    big = RunningJob(9, "x", "research", "gpu01", 4, 16, 3, 0.0, 3600)
    n.allocate(big)
    jobs = [
        pending(1, user="a", gpus=4, minutes=60),   # blocked: needs the whole node, reserved at t=3600
        pending(2, user="b", gpus=1, minutes=120),  # would delay job 1
        pending(3, user="c", gpus=1, minutes=30),   # ends before t=3600: backfilled
    ]
    plan = plan_schedule(jobs, [n], [big], 0.0, settings, {})
    assert [j for j, _ in plan.starts] == [3]
    assert 3 in plan.backfilled


def test_drained_node_gets_no_jobs(settings):
    plan = plan_schedule([pending(1)], [node(available=False)], [], 0.0, settings, {})
    assert plan.starts == []
