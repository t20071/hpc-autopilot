import shutil
from pathlib import Path

import pytest

from hpc_autopilot.config import load_settings
from hpc_autopilot.db import init_db

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def settings(tmp_path, monkeypatch):
    """A throwaway cluster home with the real cluster.toml and job scripts, ticking fast."""
    shutil.copy(ROOT / "cluster.toml", tmp_path / "cluster.toml")
    shutil.copytree(ROOT / "jobs", tmp_path / "jobs")
    text = (tmp_path / "cluster.toml").read_text(encoding="utf-8").replace("tick_seconds = 2", "tick_seconds = 0.3")
    (tmp_path / "cluster.toml").write_text(text, encoding="utf-8")
    monkeypatch.setenv("HPC_AUTOPILOT_HOME", str(tmp_path))
    s = load_settings(tmp_path)
    init_db(s)
    return s
