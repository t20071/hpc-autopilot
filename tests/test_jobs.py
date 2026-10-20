import pytest

from hpc_autopilot.jobs import JobRequest, command_allowed, submit, validate


def req(**kw):
    base = dict(name="t", user="asha", email="asha@students.example.edu", role="student", account="teaching",
                partition="gpu", cpus=2, memory_gb=4, gpus=1, time_limit_minutes=5,
                command="python jobs/train_model.py --epochs 1")
    return JobRequest(**{**base, **kw})


@pytest.mark.parametrize("command", [
    "python jobs/train_model.py --epochs 2",
    r"python jobs\train_model.py --epochs 2",
    "python jobs/../jobs/train_model.py",
])
def test_allowed_commands(settings, command):
    assert command_allowed(settings, command)


@pytest.mark.parametrize("command", [
    "python -c print(1)",
    "python -m http.server",
    "cmd /c dir",
    "python src/hpc_autopilot/cli.py",
    "python jobs/../src/hpc_autopilot/cli.py",
    "python jobs/missing.py",
])
def test_blocked_commands(settings, command):
    assert not command_allowed(settings, command)


@pytest.mark.parametrize("field,value", [
    ("name", "evil\nBcc: x@y.com"),
    ("email", "a@b.com\r\nBcc: x@y.com"),
    ("email", "a@b.com,c@d.com"),
    ("user", "bad user"),
    ("time_limit_minutes", float("nan")),
])
def test_validation_rejects_bad_input(settings, field, value):
    assert validate(settings, req(**{field: value}))


def test_registered_user_cannot_claim_a_higher_role(settings):
    errors = validate(settings, req(role="faculty", account="research"))
    assert any("registered as role 'student'" in e for e in errors)


def test_valid_request_is_queued(settings):
    assert validate(settings, req()) == []
    assert submit(settings, req()) > 0
