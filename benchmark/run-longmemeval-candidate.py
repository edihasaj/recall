#!/usr/bin/env python3
"""Fail-closed supervisor for the frozen 20 October LongMemEval candidate."""
from __future__ import annotations

import argparse
import os
import hashlib
import json
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

DAY = "2026-10-20"
DEV = f"longmemeval-history-contract-reasoning-high-development60-restart-{DAY}.json"
PARITY = f"longmemeval-validation-candidate-prompt-parity-{DAY}.json"
VALIDATION = f"longmemeval-history-contract-high-validation100-{DAY}.json"
FULL = f"longmemeval-history-contract-high-lexical-full500-{DAY}.json"
E5 = f"longmemeval-history-contract-high-e5-full500-{DAY}.json"
E5_RANKINGS = f"longmemeval-fresh-e5-full500-exact-{DAY}.json"
FIXED60 = "longmemeval-fresh-e5-fixed60-manifest-2026-10-19.json"
OLD60 = "longmemeval-fresh-e5-fixed60-corrected-2026-10-19.json"
VALIDATION_INPUT = "longmemeval-improvement-validation-input-2026-10-19.json"
FULL_INPUT = "longmemeval-amb-input-2026-10-19.json"
POLL_SECONDS = 30
CANDIDATE_ARCHIVE_SHA = "e93834ef1fc8f8d625f9235c90ac3189048ede144b29829ce9be3a710b71ec44"
RANKINGS_ARCHIVE_SHA = "44c4170943008410b21a8a088f6054b20edcbce554af59ab88c6397ce1559996"
CANDIDATE_MANIFEST = "longmemeval-validation-candidate-manifest-2026-10-20.json"
RANKINGS_MANIFEST = "longmemeval-fresh-e5-full500-exact-manifest-2026-10-20.json"


class Stop(RuntimeError): pass
class ObservationError(Stop): pass


def data(root: Path, name: str) -> Path: return root / "benchmark" / "data" / name
def load(path: Path) -> dict:
    try: return json.loads(path.read_text())
    except Exception as exc: raise Stop(f"invalid JSON: {path.name}") from exc
def maybe_load(path: Path) -> dict | None:
    try: return json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError): return None
def sha(path: Path) -> str: return hashlib.sha256(path.read_bytes()).hexdigest()
def ids(doc: dict) -> list[str]:
    if isinstance(doc.get("selected_question_ids"), list): return doc["selected_question_ids"]
    if isinstance(doc.get("selected_ids"), list): return doc["selected_ids"]
    if isinstance(doc.get("results"), list): return [row["question_id"] for row in doc["results"]]
    if isinstance(doc.get("cases"), list): return [row["question_id"] for row in doc["cases"]]
    raise Stop("report has no selected question IDs")
def exact(actual: list[str], expected: list[str], label: str) -> None:
    if len(actual) != len(expected) or len(set(actual)) != len(actual) or set(actual) != set(expected):
        raise Stop(f"{label} question IDs do not match")
def abstentions(input_doc: dict, expected: list[str]) -> set[str]:
    cases = input_doc.get("cases", [])
    if not isinstance(cases, list): raise Stop("input cases missing")
    by_id = {case.get("question_id"): case for case in cases}
    if len(by_id) != len(cases) or not set(expected).issubset(by_id):
        raise Stop("input does not contain selected IDs")
    flagged = set()
    for question_id in expected:
        case = by_id[question_id]
        expected_flag = question_id.endswith("_abs")
        if type(case.get("is_abstention")) is not bool or case["is_abstention"] != expected_flag:
            raise Stop("input abstention flags differ from frozen IDs")
        if expected_flag: flagged.add(question_id)
    return flagged
def cwd(pid: str) -> Path:
    result = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], capture_output=True, text=True)
    if result.returncode != 0: raise ObservationError(f"cwd observation failed for pid {pid}")
    for line in result.stdout.splitlines():
        if line.startswith("n"): return Path(line[1:]).resolve()
    raise ObservationError(f"cwd observation missing for pid {pid}")
def live(out: Path, script: str) -> bool:
    result = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True)
    if result.returncode != 0: raise ObservationError("ps observation failed")
    output = result.stdout
    for line in output.splitlines():
        try:
            pid, command = line.split(None, 1)
            tokens = shlex.split(command)
        except (IndexError, ValueError): continue
        if not tokens or Path(tokens[0]).name != "node": continue
        if not any(token.endswith(script) for token in tokens[1:]): continue
        if "--out" not in tokens: continue
        out_index = tokens.index("--out")
        if out_index + 1 >= len(tokens): continue
        value = Path(tokens[out_index + 1])
        resolved = value.resolve() if value.is_absolute() else cwd(pid) / value
        if resolved.resolve() == out.resolve(): return True
    return False
def sanitize(value: object) -> str:
    return re.sub(r"(?i)(token|key|authorization|bearer)\s*[=:]\s*\S+", r"\1=[redacted]", str(value))


class Supervisor:
    def __init__(self, artifact: Path):
        artifact.mkdir(parents=True, exist_ok=True)
        self.state = artifact / f"longmemeval-candidate-supervisor-{DAY}.state.json"
        self.log = artifact / f"longmemeval-candidate-supervisor-{DAY}.log"
        if not self.state.exists(): self.state.open("x").write(json.dumps({"status": "running", "stage": "initial"}))
        if not self.log.exists(): self.log.open("x").write(f"{DAY} supervisor reserved\n")
    def stage(self, name: str, status: str) -> None:
        self.state.write_text(json.dumps({"status": status, "stage": name, "updated_at": time.time()}))
        with self.log.open("a") as out: out.write(f"{name}: {sanitize(status)}\n")


def common(out: Path, input_path: Path, retrieval: str, rankings: Path | None = None) -> list[str]:
    command = ["dgx", "run", "--", os.environ.get("RECALL_NODE_PATH", "node"), "--import", "tsx",
        "benchmark/longmemeval-qa.ts", "--provider", "qwen-local", "--retrieval", retrieval,
        "--concurrency", "3", "--context-chars", "180000", "--top-k", "10", "--evidence",
        "highlighted", "--evidence-policy", "system", "--request-mode", "robust",
        "--answer-check", "none", "--reasoning-effort", "high", "--max-output-tokens", "16384",
        "--input", str(input_path.resolve()), "--out", str(out.resolve())]
    return command + ([] if rankings is None else ["--rankings", str(rankings.resolve())])


def verify(report: dict, expected: list[str], expected_abs: set[str], count: int, correct: int, abstention: int | None = None) -> None:
    if report.get("status") != "complete" or report.get("comparison_valid") is not True:
        raise Stop("report is not complete and comparison-valid")
    if not isinstance(report.get("generation_blinding"), str) or not report["generation_blinding"]:
        raise Stop("report lacks generation blinding evidence")
    exact(ids(report), expected, "report")
    rows = report.get("results", [])
    if not isinstance(rows, list) or len(rows) != count: raise Stop("report result count is wrong")
    exact([row.get("question_id") for row in rows], expected, "result")
    if any(type(row.get("correct")) is not bool for row in rows): raise Stop("report has unscored rows")
    if any(row.get("is_abstention") != (row["question_id"] in expected_abs) for row in rows):
        raise Stop("report abstention flags differ from frozen IDs")
    actual_correct = sum(row["correct"] is True for row in rows)
    actual_abstention = sum(row["correct"] is True and row["question_id"] in expected_abs for row in rows)
    actual_errors = sum(bool(row.get("error")) for row in rows)
    summary = report.get("summary", {})
    if summary.get("correct") != actual_correct or summary.get("errors") != actual_errors:
        raise Stop("report summary does not match result rows")
    if summary.get("abstention", {}).get("correct") != actual_abstention:
        raise Stop("report abstention summary does not match result rows")
    if actual_correct < correct: raise Stop("report correct threshold failed")
    if abstention is not None and actual_abstention < abstention:
        raise Stop("report abstention threshold failed")


def wait_report(path: Path, expected: list[str], expected_abs: set[str], count: int, correct: int, script: str, abstention: int | None = None) -> dict:
    while True:
        producer = live(path, script)
        report = maybe_load(path) if path.exists() else None
        if report and report.get("status") == "complete":
            verify(report, expected, expected_abs, count, correct, abstention)
            return report
        if not producer:
            report = maybe_load(path) if path.exists() else None
            if report and report.get("status") == "complete":
                verify(report, expected, expected_abs, count, correct, abstention)
                return report
            raise Stop(f"partial or invalid report without live producer: {path.name}")
        time.sleep(POLL_SECONDS)

def wait_ranking(path: Path, expected: list[str], input_doc: dict, rankings: Path, artifact: Path) -> dict:
    while True:
        producer = live(path, "benchmark/longmemeval.ts")
        report = maybe_load(path) if path.exists() else None
        if report and report.get("status") == "complete":
            verify_ranking(report, expected, input_doc, rankings, artifact)
            return report
        if not producer:
            report = maybe_load(path) if path.exists() else None
            if report and report.get("status") == "complete":
                verify_ranking(report, expected, input_doc, rankings, artifact)
                return report
            raise Stop(f"partial or invalid report without live producer: {path.name}")
        time.sleep(POLL_SECONDS)


def path_arg(value: object, cwd: Path) -> Path:
    if not isinstance(value, str): raise Stop("report path argument missing")
    path = Path(value)
    return (path if path.is_absolute() else cwd / path).resolve()
def verify_invocation(report: dict, source: Path, cwd_root: Path, out: Path, input_path: Path, retrieval: str, rankings: Path | None = None) -> None:
    invoke = report.get("invocation", {})
    wanted = {"provider": "qwen-local", "retrieval": retrieval, "concurrency": 3, "contextChars": 180000,
        "topK": 10, "evidence": "highlighted", "evidencePolicy": "system", "requestMode": "robust",
        "answerCheck": "none", "reasoningEffort": "high", "maxOutputTokens": 16384}
    if any(invoke.get(key) != value for key, value in wanted.items()): raise Stop("report invocation differs from frozen command")
    if path_arg(invoke.get("input"), cwd_root) != input_path.resolve() or path_arg(invoke.get("out"), cwd_root) != out.resolve():
        raise Stop("report input or output path differs")
    if rankings is not None and path_arg(invoke.get("rankings"), cwd_root) != rankings.resolve(): raise Stop("report rankings differ")
    hashes = report.get("hashes", {})
    if hashes.get("input") != sha(input_path): raise Stop("report input hash differs")
    if rankings is not None and hashes.get("rankings") != sha(rankings): raise Stop("report rankings hash differs")
    code = hashes.get("code")
    if not isinstance(code, dict) or not code: raise Stop("report code hashes missing")
    frozen = source.resolve()
    for path, digest in code.items():
        file = Path(path).resolve()
        if frozen not in file.parents or not file.is_file() or sha(file) != digest:
            raise Stop("report code hash differs from frozen candidate")
    if hashes.get("package_lock") != sha(source / "package-lock.json"):
        raise Stop("report package lock hash differs from frozen candidate")

def verify_archive_manifest(manifest_path: Path, root: Path, expected_sha: str, inputs: dict[str, Path] = {}) -> dict:
    manifest = load(manifest_path)
    archive = manifest.get("source_archive")
    if manifest.get("source_archive_sha256") != expected_sha or not isinstance(archive, str):
        raise Stop("frozen archive manifest hash differs")
    archive_path = manifest_path.parent / archive
    if not archive_path.is_file() or sha(archive_path) != expected_sha: raise Stop("frozen archive differs")
    with tarfile.open(archive_path) as tar:
        for member in tar:
            if not member.isfile(): continue
            source = (root / member.name).resolve()
            if root.resolve() not in source.parents or not source.is_file(): raise Stop("frozen archive member missing")
            saved = tar.extractfile(member)
            if saved is None or hashlib.sha256(saved.read()).hexdigest() != sha(source):
                raise Stop("candidate differs from frozen archive")
    for key, path in inputs.items():
        if manifest.get(key) != sha(path): raise Stop("frozen input hash differs")
    return manifest

def verify_candidate_freeze(candidate: Path, artifact: Path, validation_input: Path, full_input: Path) -> None:
    verify_archive_manifest(artifact / CANDIDATE_MANIFEST, candidate, CANDIDATE_ARCHIVE_SHA, {
        "validation_input_sha256": validation_input,
        "full_input_sha256": full_input,
    })

def verify_ranking(report: dict, expected: list[str], input_doc: dict, rankings: Path, artifact: Path) -> None:
    if report.get("status") != "complete": raise Stop("E5 ranking report is not complete")
    exact(ids(report), expected, "ranking")
    if report.get("dataset_sha256") != input_doc.get("provenance", {}).get("dataset_sha256"):
        raise Stop("E5 dataset hash differs")
    provider = report.get("local_provider", {})
    if provider.get("provider") != "multilingual-e5" or provider.get("model") != "Xenova/multilingual-e5-small":
        raise Stop("E5 provider metadata differs")
    rows, cases = report.get("results", []), {case["question_id"]: case for case in input_doc.get("cases", [])}
    if not isinstance(rows, list) or len(rows) != 500: raise Stop("E5 ranking count differs")
    exact([row.get("question_id") for row in rows], expected, "E5 result")
    for row in rows:
        source_hash, ids_row, occurrences = row.get("source_sha256"), row.get("retrieved_session_ids"), row.get("retrieved_session_occurrences")
        sessions = cases.get(row["question_id"], {}).get("sessions", [])
        if not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", source_hash): raise Stop("E5 source hash missing")
        if not isinstance(ids_row, list) or not isinstance(occurrences, list) or len(ids_row) != len(occurrences) or len(set(occurrences)) != len(occurrences):
            raise Stop("E5 exact occurrence metadata differs")
        if any(type(index) is not int or index < 0 or index >= len(sessions) or sessions[index].get("id") != session_id for session_id, index in zip(ids_row, occurrences)):
            raise Stop("E5 occurrence mapping differs")
    manifest = verify_archive_manifest(artifact / RANKINGS_MANIFEST, rankings, RANKINGS_ARCHIVE_SHA)
    if manifest.get("question_count") != 500 or manifest.get("cache_embeddings") is not True:
        raise Stop("E5 frozen manifest is incomplete")
    if manifest.get("dataset_sha256") != report["dataset_sha256"] or manifest.get("embedding_provider") != provider["provider"] or manifest.get("embedding_model") != provider["model"]:
        raise Stop("E5 frozen manifest differs")
    provenance = report.get("provenance", {})
    files = provenance.get("source_files_sha256")
    if not isinstance(files, dict) or provenance.get("package_lock_sha256") != sha(rankings / "package-lock.json"):
        raise Stop("E5 provenance missing")
    for path, digest in files.items():
        file = (rankings / path).resolve()
        if rankings.resolve() not in file.parents or not file.is_file() or sha(file) != digest:
            raise Stop("E5 provenance differs from frozen rankings source")


def copy_artifacts(report: Path, artifact: Path) -> None:
    for source in [report, Path(f"{report}.jsonl"), Path(f"{report}.progress.json")]:
        if not source.exists(): raise Stop(f"completed artifact missing: {source.name}")
        target = artifact / source.name
        if target.exists():
            if sha(target) != sha(source): raise Stop(f"artifact collision: {target.name}")
        else:
            with source.open("rb") as inp, target.open("xb") as out: shutil.copyfileobj(inp, out)

def preserve_completed(report: Path, artifact: Path) -> None:
    loaded = maybe_load(report) if report.exists() else None
    if loaded and loaded.get("status") == "complete": copy_artifacts(report, artifact)


def run_stage(supervisor: Supervisor, name: str, out: Path, command: list[str], expected: list[str], expected_abs: set[str], count: int, correct: int, artifact: Path, candidate: Path, validation_input: Path, full_input: Path, abstention: int | None = None) -> None:
    verify_candidate_freeze(candidate, artifact, validation_input, full_input)
    sidecars = [out, Path(f"{out}.jsonl"), Path(f"{out}.progress.json")]
    if any(path.exists() for path in sidecars):
        if not out.exists() and not live(out, "benchmark/longmemeval-qa.ts"):
            raise Stop(f"partial artifacts without live producer: {out.name}")
        try: report = wait_report(out, expected, expected_abs, count, correct, "benchmark/longmemeval-qa.ts", abstention)
        except Stop: preserve_completed(out, artifact); raise
        verify_invocation(report, candidate, candidate, out, Path(command[command.index("--input") + 1]), command[command.index("--retrieval") + 1],
            Path(command[command.index("--rankings") + 1]) if "--rankings" in command else None)
        copy_artifacts(out, artifact); return
    supervisor.stage(name, "launching")
    log = artifact / f"{out.name}.run.log"
    try: handle = log.open("x")
    except FileExistsError as exc: raise Stop(f"stage log already exists: {log.name}") from exc
    process = subprocess.Popen(command, cwd=out.parents[2], stdout=handle, stderr=subprocess.STDOUT)
    handle.close()
    while not live(out, "benchmark/longmemeval-qa.ts"):
        exit_code = process.poll()
        if exit_code is not None:
            if not (maybe_load(out) or {}).get("status") == "complete":
                preserve_completed(out, artifact)
                supervisor.stage(name, f"producer exited {exit_code}")
                raise Stop(f"{name} producer exited {exit_code} before a live node producer")
            break
        time.sleep(1)
    try: report = wait_report(out, expected, expected_abs, count, correct, "benchmark/longmemeval-qa.ts", abstention)
    except Stop: preserve_completed(out, artifact); raise
    exit_code = process.wait()
    if exit_code != 0: preserve_completed(out, artifact); raise Stop(f"{name} producer exited {exit_code}")
    verify_invocation(report, candidate, candidate, out, Path(command[command.index("--input") + 1]), command[command.index("--retrieval") + 1],
        Path(command[command.index("--rankings") + 1]) if "--rankings" in command else None)
    copy_artifacts(out, artifact); supervisor.stage(name, "complete")


def main() -> int:
    parser = argparse.ArgumentParser()
    for option in ("candidate-dir", "development-dir", "rankings-dir", "artifact-dir"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    candidate, development, rankings, artifact = (getattr(args, key.replace("-", "_")).resolve() for key in ("candidate-dir", "development-dir", "rankings-dir", "artifact-dir"))
    validation_input, full_input = data(candidate, VALIDATION_INPUT), data(candidate, FULL_INPUT)
    validation, full, e5 = data(candidate, VALIDATION), data(candidate, FULL), data(candidate, E5)
    e5_rankings = data(rankings, E5_RANKINGS)
    plan = [common(validation, validation_input, "lexical"), common(full, full_input, "lexical"), common(e5, full_input, "cached", e5_rankings)]
    if args.dry_run:
        print(json.dumps({"commands": plan}, indent=2)); return 0
    supervisor = Supervisor(artifact)
    try:
        parity = load(artifact / PARITY)
        if parity.get("status") != "complete" or parity.get("cases") != 500 or not parity.get("evidence_identical") or not parity.get("answer_prompts_identical"): raise Stop("prompt parity audit failed")
        fixed = ids(load(artifact / FIXED60)); old = ids(load(data(candidate, OLD60)))
        exact(fixed, old, "fixed60")
        verify_candidate_freeze(candidate, artifact, validation_input, full_input)
        dev_input, dev_rankings = data(development, FULL_INPUT), data(development, OLD60)
        dev_abs = abstentions(load(dev_input), fixed)
        supervisor.stage("waiting-development", "waiting")
        dev_out = data(development, DEV)
        try: dev = wait_report(dev_out, fixed, dev_abs, 60, 53, "benchmark/longmemeval-qa.ts")
        except Stop: preserve_completed(data(development, DEV), artifact); raise
        verify_invocation(dev, development, development, dev_out, dev_input, "cached", dev_rankings)
        copy_artifacts(dev_out, artifact)
        validation_doc, full_doc = load(validation_input), load(full_input)
        validation_ids, full_ids = ids(validation_doc), ids(full_doc)
        run_stage(supervisor, "validation", validation, plan[0], validation_ids, abstentions(validation_doc, validation_ids), 100, 88, artifact, candidate, validation_input, full_input, 12)
        run_stage(supervisor, "full", full, plan[1], full_ids, abstentions(full_doc, full_ids), 500, 440, artifact, candidate, validation_input, full_input, 23)
        supervisor.stage("waiting-rankings", "waiting")
        wait_ranking(e5_rankings, full_ids, full_doc, rankings, artifact)
        copy_artifacts(e5_rankings, artifact)
        run_stage(supervisor, "e5", e5, plan[2], full_ids, abstentions(full_doc, full_ids), 500, 440, artifact, candidate, validation_input, full_input, 23)
        supervisor.stage("complete", "complete"); return 0
    except ObservationError as error:
        supervisor.stage("observation-error", sanitize(error)); print(f"observation error: {sanitize(error)}", file=sys.stderr); return 3
    except Stop as error:
        supervisor.stage("failed", sanitize(error)); print(f"stopped: {sanitize(error)}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
