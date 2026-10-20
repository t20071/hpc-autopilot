import io
import zipfile

import pytest

from hpc_autopilot import jobs, uploads
from hpc_autopilot.db import session
from hpc_autopilot.service import Autopilot


def make_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            info = zipfile.ZipInfo(name)
            info.filename = name  # keep hostile names exactly as written
            z.writestr(info, text)
    return buf.getvalue()


def run(settings, command):
    job_id = jobs.submit(settings, jobs.JobRequest(
        name="upload-test", user="asha", email="asha@students.example.edu", role="student", account="teaching",
        partition="cpu", cpus=1, memory_gb=1, gpus=0, time_limit_minutes=1, command=command,
    ))
    Autopilot(settings).run_until_idle(timeout_s=60)
    with session(settings) as conn:
        return dict(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())


def test_uploaded_script_runs_and_emails(settings):
    path = uploads.save_script(settings, "asha", "hello.py", b"import os\nprint('hello from', os.environ['HPC_NODE'])\n")
    rel = path.relative_to(settings.home).as_posix()
    assert rel == "jobs/uploads/asha/hello.py"
    job = run(settings, f"python {rel}")
    assert job["state"] == "COMPLETED"
    assert "hello from cpu01" in (settings.home / job["workdir"] / "output.log").read_text(encoding="utf-8")
    assert any("Your job is completed." in e.read_text(encoding="utf-8") for e in settings.outbox_dir.glob("*.eml"))


def test_zip_project_runs_from_its_own_folder(settings):
    data = make_zip({
        "proj/train.py": "print(open('data/x.txt').read())\n",
        "proj/data/x.txt": "relative paths work",
        "proj/.git/config": "skipped",
    })
    project, entries = uploads.save_project(settings, "asha", "proj.zip", data)
    assert [e.name for e in entries] == ["train.py"]
    assert not (project / ".git").exists()
    job = run(settings, f"python {entries[0].relative_to(settings.home).as_posix()}")
    assert job["state"] == "COMPLETED"
    assert "relative paths work" in (settings.home / job["workdir"] / "output.log").read_text(encoding="utf-8")


@pytest.mark.parametrize("files", [{"../evil.py": "x"}, {"/abs.py": "x"}, {"a/../../evil.py": "x"}])
def test_zip_cannot_escape_the_upload_folder(settings, files):
    with pytest.raises(ValueError):
        uploads.save_project(settings, "asha", "bad.zip", make_zip(files))
    assert not (settings.jobs_dir / "evil.py").exists()


def test_upload_rules(settings):
    with pytest.raises(ValueError):
        uploads.save_script(settings, "asha", "notes.txt", b"x")
    with pytest.raises(ValueError):
        uploads.save_script(settings, "../asha", "x.py", b"x")
    with pytest.raises(ValueError):
        uploads.save_project(settings, "asha", "x.zip", b"not a zip")
    path = uploads.save_script(settings, "asha", "../../sneaky name!.py", b"print(1)")
    assert path.parent == settings.jobs_dir / "uploads" / "asha"
    assert [r["item"] for r in uploads.list_uploads(settings)] == [path.name]
    uploads.delete_upload(settings, "asha", path.name)
    assert uploads.list_uploads(settings) == []
