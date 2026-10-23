#!/usr/bin/env python3
"""Run the frozen v4 experiments once shared Qwen capacity is quiet.

This controller only gates complete stages. It never retries a model request,
changes a prompt, or cancels another workload. Events contain metrics/status
only. The overloaded first attempt remains a separate recorded experiment.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
from datetime import datetime, timezone


SSH_OPTIONS = [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    "-o", "RequestTTY=no", "-o", "RemoteCommand=none",
]
WORKERS = os.environ.get("RECALL_CAPACITY_WORKERS", "")
REMOTE_METRICS = (
    f"for w in {WORKERS}; do "
    'printf "worker %s\\n" "$w"; '
    'curl -fsS -m5 "http://$w:18300/metrics" | '
    'grep -E "^vllm:num_requests_(running|waiting)\\{"; done'
)
# Host, key and worker addresses are machine-local; set them in the environment.
INNER_SSH = [
    "ssh", *SSH_OPTIONS, "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes",
    "-i", os.environ.get("RECALL_CAPACITY_SSH_KEY", ""),
    os.environ.get("RECALL_CAPACITY_SSH_TARGET", ""), REMOTE_METRICS,
]


def utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--max-running", type=int, choices=range(0, 4), default=1,
                        help="Maximum other running requests per worker before a stage (each worker has 8 slots).")
    parser.add_argument("--once", action="store_true", help="Read one capacity sample without model calls.")
    args = parser.parse_args()
    root, snapshot = args.root.resolve(), args.snapshot.resolve()
    freeze_path = root / "benchmark/data/temporal-v4-frozen-2026-10-19.json"
    freeze = json.loads(freeze_path.read_text())
    for relative, expected in freeze["files"].items():
        actual = hashlib.sha256((snapshot / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f"Frozen snapshot changed: {relative}")
    state: dict = {
        "status": "waiting_for_capacity", "started_at_utc": utc(),
        "snapshot": str(snapshot), "freeze": str(freeze_path),
        "policy": {"running_max_each": args.max_running, "waiting_each": 0, "quiet_samples": 3, "sample_seconds": 20},
        "events": [], "stages": [],
    }

    def save() -> None:
        temporary = args.state.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(args.state)

    def sample() -> list[dict]:
        response = subprocess.run(
            ["ssh", *SSH_OPTIONS, "macbook", shlex.join(INNER_SSH)],
            capture_output=True, text=True, timeout=40, check=False,
        )
        if response.returncode:
            raise RuntimeError("capacity_metrics_unavailable")
        workers: list[dict] = []
        current: dict | None = None
        for line in response.stdout.splitlines():
            if line.startswith("worker "):
                current = {"worker": line.split()[1]}
                workers.append(current)
            elif current is not None:
                match = re.match(r"vllm:num_requests_(running|waiting)\{[^}]*\}\s+([0-9.eE+-]+)$", line)
                if match:
                    current[match[1]] = current.get(match[1], 0) + float(match[2])
        if len(workers) != 2 or any("running" not in w or "waiting" not in w for w in workers):
            raise RuntimeError("capacity_metrics_incomplete")
        return workers

    if args.once:
        print(json.dumps({"sampled_at_utc": utc(), "workers": sample()}))
        return
    if args.state.exists():
        raise RuntimeError("Refusing to overwrite an existing controller record.")
    save()
    stages = [
        ("development_availability_rerun", "temporal-ump-v2.ts", [], "temporal-ump-v2-capacity-fresh-2026-10-19.json"),
        ("challenge", "temporal-ump-v2.ts", ["--challenge"], "temporal-v4-challenge-fresh-2026-10-19.json"),
        ("public_434", "temporal-real-v4.ts", ["--rerun-exposed-ids"], "temporal-v4-real-2026-10-19.json"),
    ]
    environment = dict(os.environ)
    node_dir = os.path.dirname(os.environ.get("RECALL_NODE_PATH", ""))
    if node_dir:
        environment["PATH"] = node_dir + os.pathsep + environment.get("PATH", "")
    for name, script, extra, filename in stages:
        output = root / "benchmark/data" / filename
        if output.exists():
            raise RuntimeError(f"Refusing to overwrite {filename}")
        quiet = 0
        while quiet < 3:
            try:
                workers = sample()
                quiet = quiet + 1 if all(w["running"] <= args.max_running and w["waiting"] == 0 for w in workers) else 0
                event = {"at_utc": utc(), "stage": name, "workers": workers, "quiet_samples": quiet}
            except (RuntimeError, subprocess.TimeoutExpired):
                quiet = 0
                event = {"at_utc": utc(), "stage": name, "error": "capacity_metrics_unavailable"}
            state["events"].append(event)
            save()
            print(json.dumps(event), flush=True)
            if quiet < 3:
                time.sleep(20)
        stage = {"name": name, "status": "running", "started_at_utc": utc(), "output": str(output)}
        state["stages"].append(stage)
        state["status"] = "running"
        save()
        log = root / "benchmark/data" / f"{filename}.log"
        command = ["dgx", "run", "node", "--import", "tsx", f"benchmark/{script}",
                   "--provider", "qwen-local", *extra, "--out", str(output)]
        with log.open("x") as handle:
            result = subprocess.run(command, cwd=snapshot, env=environment, stdout=handle, stderr=subprocess.STDOUT)
        stage.update({"status": "complete" if result.returncode == 0 else "failed",
                      "exit_code": result.returncode, "finished_at_utc": utc()})
        save()
        if result.returncode:
            state["status"] = "failed"
            save()
            raise RuntimeError(f"Stage failed: {name}")
        state["status"] = "waiting_for_capacity"
        save()
    state["status"] = "complete"
    state["finished_at_utc"] = utc()
    save()


if __name__ == "__main__":
    main()
