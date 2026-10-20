"""Shared helpers for the Streamlit dashboard pages."""

from __future__ import annotations

import time

import streamlit as st

from .config import Settings, load_settings
from .db import init_db


@st.cache_resource
def get_settings() -> Settings:
    settings = load_settings()
    init_db(settings)
    return settings


def ago(ts: float | None) -> str:
    if not ts:
        return "never"
    seconds = int(time.time() - ts)
    if seconds < 60:
        return f"{seconds}s ago"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    return f"{seconds // 3600} h ago"
