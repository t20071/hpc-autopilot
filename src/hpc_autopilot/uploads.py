"""User code uploads: a single .py script or a .zip project, stored under jobs/uploads/<user>/.

Uploaded code runs like any other job, so the same rules apply: only Python files inside the
jobs folder can be started, and each job runs in its own process with its own output folder.
"""

from __future__ import annotations

import io
import re
import shutil
import time
import zipfile
from pathlib import Path, PurePosixPath

from .config import Settings

MAX_SCRIPT_BYTES = 5 * 1024 * 1024
MAX_ZIP_BYTES = 50 * 1024 * 1024
MAX_UNZIPPED_BYTES = 200 * 1024 * 1024
MAX_ZIP_FILES = 2000
SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")
USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,31}$")


def uploads_dir(settings: Settings) -> Path:
    return settings.jobs_dir / "uploads"


def _user_dir(settings: Settings, user: str) -> Path:
    if not USERNAME.match(user):
        raise ValueError("Enter a valid username first (letters, digits, '.', '_' or '-').")
    return uploads_dir(settings) / user


def _safe_filename(name: str) -> str:
    stem = SAFE_NAME.sub("_", Path(name).name).strip("._")
    if not stem:
        raise ValueError("That file name cannot be used.")
    return stem


def save_script(settings: Settings, user: str, filename: str, data: bytes) -> Path:
    """Save one .py file and return its path."""
    name = _safe_filename(filename)
    if not name.endswith(".py"):
        raise ValueError("Only Python (.py) files can be run. Upload a .zip for a whole project.")
    if len(data) > MAX_SCRIPT_BYTES:
        raise ValueError("Scripts are limited to 5 MB. Put data files on shared storage instead.")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("The script is not a UTF-8 text file.") from None
    dest = _user_dir(settings, user) / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


def save_project(settings: Settings, user: str, filename: str, data: bytes) -> tuple[Path, list[Path]]:
    """Unpack a .zip project safely. Returns the project folder and the .py files that can be run."""
    if len(data) > MAX_ZIP_BYTES:
        raise ValueError("Zip uploads are limited to 50 MB.")
    project = _user_dir(settings, user) / _safe_filename(Path(filename).stem)
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("That is not a valid .zip file.") from None
    with archive:
        members = [m for m in archive.infolist() if not m.is_dir()]
        for m in members:  # refuse anything that tries to leave the project folder
            raw = m.filename.replace("\\", "/")
            if raw.startswith("/") or ":" in raw or ".." in raw.split("/") or (m.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"Unsafe path in zip: {m.filename}")
        if len(members) > MAX_ZIP_FILES:
            raise ValueError(f"The zip has more than {MAX_ZIP_FILES} files.")
        if sum(m.file_size for m in members) > MAX_UNZIPPED_BYTES:
            raise ValueError("The zip unpacks to more than 200 MB.")
        # strip one shared top folder ("myproject/train.py" -> "train.py")
        parts = [PurePosixPath(m.filename).parts for m in members]
        shared = parts[0][0] if parts and all(len(p) > 1 and p[0] == parts[0][0] for p in parts) else None
        staging = project.with_name(project.name + f".tmp{int(time.time())}")
        try:
            for m, p in zip(members, parts):
                rel = PurePosixPath(*p[1:]) if shared else PurePosixPath(*p)
                if any(part.startswith(".") for part in rel.parts) or "__pycache__" in rel.parts:
                    continue  # skip .git, .venv, caches
                target = staging.joinpath(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(m) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    if project.exists():
        shutil.rmtree(project)
    staging.rename(project)
    entries = entry_points(project)
    if not entries:
        shutil.rmtree(project)
        raise ValueError("The zip has no .py files to run.")
    return project, entries


def entry_points(project: Path) -> list[Path]:
    """Runnable scripts in a project: .py files at the top level or one folder down."""
    files = sorted(project.glob("*.py")) + sorted(project.glob("*/*.py"))
    return [f for f in files if f.name != "__init__.py"][:50]


def list_uploads(settings: Settings) -> list[dict]:
    """Every uploaded script that can be run, newest first."""
    rows = []
    base = uploads_dir(settings)
    if not base.exists():
        return rows
    for user_dir in sorted(p for p in base.iterdir() if p.is_dir()):
        for item in user_dir.iterdir():
            scripts = [item] if item.is_file() and item.suffix == ".py" else entry_points(item) if item.is_dir() else []
            for script in scripts:
                rel = script.relative_to(settings.home).as_posix()
                rows.append({
                    "user": user_dir.name,
                    "item": item.name,
                    "script": rel,
                    "command": f"python {rel}",
                    "kind": "project" if item.is_dir() else "script",
                    "size_kb": round(script.stat().st_size / 1024, 1),
                    "uploaded": item.stat().st_mtime,
                })
    return sorted(rows, key=lambda r: -r["uploaded"])


def delete_upload(settings: Settings, user: str, item: str) -> None:
    target = _user_dir(settings, user) / _safe_filename(item)
    if not target.resolve().is_relative_to(uploads_dir(settings).resolve()) or not target.exists():
        raise ValueError(f"No upload named {item} for {user}.")
    shutil.rmtree(target) if target.is_dir() else target.unlink()


def working_dir(settings: Settings, script: Path) -> Path:
    """Uploaded code runs from its own folder, so relative paths like data/train.csv work."""
    try:
        rel = script.resolve().relative_to(uploads_dir(settings).resolve())
    except ValueError:
        return settings.home
    user_dir = uploads_dir(settings) / rel.parts[0]
    return user_dir / rel.parts[1] if len(rel.parts) > 2 else user_dir
