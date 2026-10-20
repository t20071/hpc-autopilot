"""A realistic batch of jobs from students, PhD scholars, faculty and a startup."""

from __future__ import annotations

from .config import Settings
from .jobs import JobRequest, submit

TRAIN = "python jobs/train_model.py"

DEMO_JOBS = [
    JobRequest("pi-estimate", "asha", "asha@students.example.edu", "student", "teaching", "cpu",
               cpus=4, memory_gb=8, time_limit_minutes=5, command="python jobs/monte_carlo_pi.py --samples 4000000"),
    JobRequest("cnn-homework", "asha", "asha@students.example.edu", "student", "teaching", "gpu",
               cpus=4, memory_gb=16, gpus=1, time_limit_minutes=10, command=f"{TRAIN} --epochs 10 --seconds-per-epoch 2"),
    JobRequest("cnn-tuning", "asha", "asha@students.example.edu", "student", "teaching", "gpu",
               cpus=4, memory_gb=16, gpus=1, time_limit_minutes=10, command=f"{TRAIN} --epochs 6 --seconds-per-epoch 2"),
    JobRequest("llm-finetune", "rahul", "rahul@phd.example.edu", "phd", "research", "gpu",
               cpus=16, memory_gb=128, gpus=2, time_limit_minutes=30, command=f"{TRAIN} --epochs 15 --seconds-per-epoch 2"),
    JobRequest("supply-chain-forecast", "prof_mehta", "mehta@faculty.example.edu", "faculty", "research", "gpu",
               cpus=32, memory_gb=200, gpus=4, time_limit_minutes=30, command=f"{TRAIN} --epochs 20 --seconds-per-epoch 2"),
    JobRequest("vision-model", "neo_ai", "team@neoai.example.com", "startup", "startups", "gpu",
               cpus=24, memory_gb=192, gpus=4, time_limit_minutes=30, command=f"{TRAIN} --epochs 12 --seconds-per-epoch 2"),
    JobRequest("rl-agent", "lin", "lin@phd.example.edu", "phd", "research", "gpu",
               cpus=8, memory_gb=64, gpus=2, time_limit_minutes=20, command=f"{TRAIN} --epochs 8 --seconds-per-epoch 2"),
    JobRequest("survey-cleaning", "kavya", "kavya@phd.example.edu", "phd", "research", "cpu",
               cpus=8, memory_gb=32, time_limit_minutes=10, command="python jobs/data_prep.py --rows 200000"),
    JobRequest("ablation-run", "rahul", "rahul@phd.example.edu", "phd", "research", "gpu",
               cpus=8, memory_gb=32, gpus=1, time_limit_minutes=10, command=f"{TRAIN} --epochs 5 --fail-at 3"),
    JobRequest("long-simulation", "prof_mehta", "mehta@faculty.example.edu", "faculty", "research", "gpu",
               cpus=8, memory_gb=64, gpus=1, time_limit_minutes=1, command=f"{TRAIN} --epochs 40 --seconds-per-epoch 2"),
]


def submit_demo_batch(settings: Settings) -> list[int]:
    return [submit(settings, req) for req in DEMO_JOBS if req.role in settings.qos]
