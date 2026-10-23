#!/usr/bin/env python3
"""Fail-closed serial supervisor for the frozen adaptive LongMemEval follow-up."""
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
ARCHIVE_SHA = "84d85b0e816427be300798b3953017db094ab5d4272f36d060bc0abbb57c2def"
FIXED = "longmemeval-history-contract-high-e5-full500-2026-10-20.json"
DEV7 = "longmemeval-adaptive-development7-2026-10-20.json"
DEV60 = "longmemeval-adaptive-development60-2026-10-20.json"
FOLLOWUP = "longmemeval-adaptive-followup100-2026-10-20.json"
FULL = "longmemeval-adaptive-e5-full500-2026-10-20.json"
FULL_INPUT = "longmemeval-amb-input-2026-10-19.json"
FOLLOWUP_INPUT = "longmemeval-adaptive-followup100-input-2026-10-20.json"
DEV7_RANK = "longmemeval-adaptive-development7-verified-rankings-2026-10-20.json"
DEV60_RANK = "longmemeval-adaptive-fixed60-verified-rankings-2026-10-20.json"
MANIFEST = "longmemeval-adaptive-candidate-manifest-2026-10-20.json"
FOLLOWUP_MANIFEST = "longmemeval-adaptive-followup100-manifest-2026-10-20.json"
ROUTING_AUDIT = "longmemeval-adaptive-development-routing-audit-2026-10-20.json"
CONTROLS = "longmemeval-adaptive-followup100-controls-2026-10-20.json"
FIXED60_MANIFEST = "longmemeval-fresh-e5-fixed60-manifest-2026-10-19.json"
PRIOR_VALIDATION_MANIFEST = "longmemeval-improvement-validation-manifest-2026-10-19.json"
RANKINGS_MANIFEST = "longmemeval-fresh-e5-full500-exact-manifest-2026-10-20.json"
RANKINGS_ARCHIVE = "longmemeval-fresh-e5-full500-exact-source-2026-10-20.tar.gz"
RANKINGS_ARCHIVE_SHA = "44c4170943008410b21a8a088f6054b20edcbce554af59ab88c6397ce1559996"
FIXED_SOURCE_MANIFEST = "longmemeval-validation-candidate-complete-source-manifest-2026-10-20.json"
FIXED_SOURCE_ARCHIVE = "longmemeval-validation-candidate-complete-source-2026-10-20.tar.gz"
FIXED_SOURCE_ARCHIVE_SHA = "e1d608f47668af6155840956565dd42bc771f1c5c0e9d36654385b4b35de3f6f"
ORIGINAL7 = {"0a995998", "6d550036", "3a704032", "dd2973ad", "32260d93", "b46e15ed", "830ce83f"}
POLL = 30
CANDIDATE_POINTER = Path("/tmp/recall-lme-adaptive-candidate-path")

class Stop(RuntimeError): pass
class Observation(Stop): pass
class Terminal(Stop): pass

def data(root: Path, name: str) -> Path: return root / "benchmark" / "data" / name
def sha(path: Path) -> str: return hashlib.sha256(path.read_bytes()).hexdigest()
def load(path: Path) -> dict:
    try: return json.loads(path.read_text())
    except Exception as exc: raise Stop(f"invalid JSON: {path.name}") from exc
def maybe(path: Path) -> dict | None:
    try: return json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError): return None
def ids(doc: dict) -> list[str]:
    for key in ("selected_question_ids", "selected_ids"):
        if isinstance(doc.get(key), list): return doc[key]
    if isinstance(doc.get("results"), list): return [row["question_id"] for row in doc["results"]]
    if isinstance(doc.get("cases"), list): return [row["question_id"] for row in doc["cases"]]
    raise Stop("missing selected question IDs")
def exact(actual: list[str], expected: list[str], label: str) -> None:
    if len(actual) != len(expected) or len(set(actual)) != len(actual) or set(actual) != set(expected):
        raise Stop(f"{label} IDs differ")
def cases(doc: dict, expected: list[str]) -> dict[str, dict]:
    values = doc.get("cases", [])
    result = {row.get("question_id"): row for row in values} if isinstance(values, list) else {}
    if len(result) != len(values) or not set(expected).issubset(result): raise Stop("input cases differ")
    return result
def abstentions(doc: dict, expected: list[str]) -> set[str]:
    selected = cases(doc, expected)
    result = set()
    for question_id in expected:
        case, flag = selected[question_id], question_id.endswith("_abs")
        if type(case.get("is_abstention")) is not bool or case["is_abstention"] != flag: raise Stop("input abstention flags differ")
        if flag: result.add(question_id)
    return result
def types(doc: dict, expected: list[str]) -> dict[str, str]:
    selected = cases(doc, expected)
    result = {question_id: selected[question_id].get("question_type") for question_id in expected}
    if any(not isinstance(value, str) or not value for value in result.values()): raise Stop("input question types differ")
    return result
def verify_followup(manifest: dict, full_doc: dict, follow_doc: dict, fixed60: list[str], prior_validation: list[str]) -> None:
    follow_ids = ids(follow_doc)
    if set(manifest.get("excluded_development_ids", [])) != set(fixed60) or set(manifest.get("excluded_prior_validation_ids", [])) != set(prior_validation):
        raise Stop("follow-up exclusions differ from frozen cohorts")
    if not set(follow_ids).isdisjoint(fixed60) or not set(follow_ids).isdisjoint(prior_validation):
        raise Stop("follow-up cohort overlaps frozen development or validation")
    full_cases, follow_cases = cases(full_doc, follow_ids), cases(follow_doc, follow_ids)
    if any(follow_cases[question_id] != full_cases[question_id] for question_id in follow_ids):
        raise Stop("follow-up cases differ from same-ID full prepared cases")
def sanitize(value: object) -> str:
    return re.sub(r"(?i)(token|key|authorization|bearer)\s*[=:]\s*\S+", r"\1=[redacted]", str(value))
def sources_hash(case: dict) -> str:
    question, sessions = case.get("question"), case.get("sessions")
    if not isinstance(question, str) or not isinstance(sessions, list): raise Stop("E5 source input differs")
    source = []
    for session in sessions:
        if not isinstance(session, dict) or any(not isinstance(session.get(key), str) for key in ("id", "date", "text")):
            raise Stop("E5 source session differs")
        source.append([session["id"], session["date"], session["text"]])
    value = json.dumps([question, source], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-16le")).hexdigest()

def cwd(pid: str) -> Path:
    result = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], capture_output=True, text=True)
    if result.returncode != 0: raise Observation("cwd observation failed")
    for line in result.stdout.splitlines():
        if line.startswith("n"): return Path(line[1:]).resolve()
    raise Observation("cwd observation missing")
def live(out: Path) -> bool:
    result = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True)
    if result.returncode != 0: raise Observation("ps observation failed")
    for line in result.stdout.splitlines():
        try: pid, command = line.split(None, 1); tokens = shlex.split(command)
        except (ValueError, IndexError): continue
        if not tokens or Path(tokens[0]).name != "node" or "benchmark/longmemeval-qa.ts" not in tokens or "--out" not in tokens: continue
        index = tokens.index("--out")
        if index + 1 >= len(tokens): continue
        value = Path(tokens[index + 1])
        observed = value.resolve() if value.is_absolute() else (cwd(pid) / value).resolve()
        if observed == out.resolve(): return True
    return False

def archive(manifest_path: Path, root: Path, expected_sha: str, inputs: dict[str, Path] | None = None) -> dict:
    manifest = load(manifest_path)
    name = manifest.get("source_archive")
    path = manifest_path.parent / str(name)
    if manifest.get("source_archive_sha256") != expected_sha or not path.is_file() or sha(path) != expected_sha:
        raise Stop("frozen archive hash differs")
    with tarfile.open(path) as tar:
        for member in tar:
            if not member.isfile(): continue
            source = (root / member.name).resolve()
            if root.resolve() not in source.parents or not source.is_file(): raise Stop("archived source member missing")
            handle = tar.extractfile(member)
            if handle is None or hashlib.sha256(handle.read()).hexdigest() != sha(source): raise Stop("archived source differs")
    for key, value in (inputs or {}).items():
        if manifest.get(key) != sha(value): raise Stop("frozen input hash differs")
    return manifest

def command(out: Path, input_path: Path, retrieval: str, rankings: Path | None = None) -> list[str]:
    value = ["dgx", "run", "--", os.environ.get("RECALL_NODE_PATH", "node"), "--import", "tsx",
        "benchmark/longmemeval-qa.ts", "--provider", "qwen-local", "--retrieval", retrieval,
        "--concurrency", "3", "--context-chars", "180000", "--top-k", "10", "--evidence", "highlighted",
        "--evidence-policy", "system", "--request-mode", "robust", "--answer-check", "none",
        "--reasoning-effort", "adaptive", "--max-output-tokens", "16384",
        "--input", str(input_path.resolve()), "--out", str(out.resolve())]
    return value + ([] if rankings is None else ["--rankings", str(rankings.resolve())])

def verify(report: dict, expected: list[str], expected_abs: set[str], expected_types: dict[str, str], minimum: int = 0, abs_minimum: int = 0, preferences: int = 0, original7: bool = False) -> tuple[int, int]:
    if report.get("status") != "complete" or report.get("comparison_valid") is not True or not report.get("generation_blinding"):
        raise Stop("report is incomplete or unblinded")
    exact(ids(report), expected, "report")
    rows = report.get("results", [])
    if not isinstance(rows, list) or len(rows) != len(expected): raise Stop("result count differs")
    exact([row.get("question_id") for row in rows], expected, "result")
    if any(type(row.get("correct")) is not bool or row.get("is_abstention") != (row["question_id"] in expected_abs) for row in rows):
        raise Stop("result verdict or abstention metadata differs")
    if any(row.get("question_type") != expected_types[row["question_id"]] for row in rows):
        raise Stop("result question types differ from frozen input")
    if any(row.get("error") and row["correct"] is not False for row in rows):
        raise Stop("errored result has a credited verdict")
    correct = sum(row["correct"] for row in rows)
    abs_correct = sum(row["correct"] for row in rows if row["question_id"] in expected_abs)
    errors = sum(bool(row.get("error")) for row in rows)
    summary = report.get("summary", {})
    if summary.get("correct") != correct or summary.get("errors") != errors or summary.get("abstention", {}).get("correct") != abs_correct:
        raise Stop("summary differs from result rows")
    if correct < minimum or abs_correct < abs_minimum: raise Stop("acceptance gate failed")
    if preferences:
        preference_rows = [row for row in rows if row.get("question_type") == "single-session-preference"]
        if len(preference_rows) != 30 or sum(row["correct"] for row in preference_rows) < preferences:
            raise Stop("preference gate failed")
    if original7 and any(not next((row["correct"] for row in rows if row["question_id"] == question_id), False) for question_id in ORIGINAL7):
        raise Stop("original development failures not all correct")
    return correct, abs_correct

def verify_invocation(report: dict, root: Path, out: Path, input_path: Path, retrieval: str, rankings: Path | None, effort: str) -> None:
    call = report.get("invocation", {})
    expected = {"provider": "qwen-local", "retrieval": retrieval, "concurrency": 3, "contextChars": 180000,
        "topK": 10, "evidence": "highlighted", "evidencePolicy": "system", "requestMode": "robust",
        "answerCheck": "none", "reasoningEffort": effort, "maxOutputTokens": 16384}
    if any(call.get(key) != value for key, value in expected.items()): raise Stop("invocation differs")
    def arg(key: str) -> Path:
        value = Path(call.get(key, "")); return (value if value.is_absolute() else root / value).resolve()
    if arg("out") != out.resolve() or arg("input") != input_path.resolve(): raise Stop("invocation paths differ")
    if rankings is not None and arg("rankings") != rankings.resolve(): raise Stop("ranking path differs")
    hashes = report.get("hashes", {})
    if hashes.get("input") != sha(input_path) or (rankings and hashes.get("rankings") != sha(rankings)): raise Stop("input hash differs")
    code = hashes.get("code", {})
    if not isinstance(code, dict) or not code or hashes.get("package_lock") != sha(root / "package-lock.json"): raise Stop("code provenance missing")
    for path, digest in code.items():
        file = Path(path).resolve()
        if root.resolve() not in file.parents or not file.is_file() or sha(file) != digest: raise Stop("code provenance differs")

def jsonl_equal(out: Path, report: dict) -> None:
    path = Path(f"{out}.jsonl")
    if not path.is_file(): raise Stop("JSONL output missing")
    try: rows = [json.loads(line) for line in path.read_bytes().split(b"\n") if line]
    except json.JSONDecodeError as exc: raise Stop("invalid JSONL") from exc
    if len(rows) != len(report["results"]): raise Stop("JSONL result count differs")
    seen = set()
    for row in rows:
        index = row.get("index")
        if type(index) is not int or index < 0 or index >= len(report["results"]) or index in seen: raise Stop("JSONL indices differ")
        seen.add(index)
        if {key: value for key, value in row.items() if key != "index"} != report["results"][index]:
            raise Stop("JSONL differs from final results")

def verify_e5(report: dict, expected: list[str], full_doc: dict, rankings: Path, artifact: Path) -> None:
    if report.get("status") != "complete": raise Stop("E5 ranking report is incomplete")
    exact(ids(report), expected, "E5 ranking")
    provider = report.get("local_provider", {})
    if report.get("dataset_sha256") != full_doc.get("provenance", {}).get("dataset_sha256") or provider.get("provider") != "multilingual-e5" or provider.get("model") != "Xenova/multilingual-e5-small":
        raise Stop("E5 ranking dataset or provider differs")
    rows = report.get("results", [])
    if not isinstance(rows, list) or len(rows) != len(expected): raise Stop("E5 ranking result count differs")
    exact([row.get("question_id") for row in rows], expected, "E5 ranking results")
    source_cases = cases(full_doc, expected)
    for row in rows:
        source_hash, source_ids, occurrences = row.get("source_sha256"), row.get("retrieved_session_ids"), row.get("retrieved_session_occurrences")
        sessions = source_cases[row["question_id"]].get("sessions", [])
        if not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", source_hash):
            raise Stop("E5 source fingerprint missing")
        if source_hash != sources_hash(source_cases[row["question_id"]]):
            raise Stop("E5 source fingerprint differs")
        if not isinstance(source_ids, list) or not isinstance(occurrences, list) or len(source_ids) != len(occurrences) or len(set(occurrences)) != len(occurrences):
            raise Stop("E5 occurrence metadata differs")
        if any(type(index) is not int or index < 0 or index >= len(sessions) or sessions[index].get("id") != source_id for source_id, index in zip(source_ids, occurrences)):
            raise Stop("E5 occurrence mapping differs")
    manifest = archive(artifact / RANKINGS_MANIFEST, rankings, RANKINGS_ARCHIVE_SHA)
    if manifest.get("status") != "frozen_before_run" or manifest.get("question_count") != 500 or manifest.get("cache_embeddings") is not True:
        raise Stop("E5 ranking manifest differs")
    if manifest.get("dataset_sha256") != report["dataset_sha256"] or manifest.get("embedding_provider") != provider["provider"] or manifest.get("embedding_model") != provider["model"]:
        raise Stop("E5 ranking manifest provenance differs")
    provenance = report.get("provenance", {})
    files = provenance.get("source_files_sha256")
    if not isinstance(files, dict) or provenance.get("package_lock_sha256") != sha(rankings / "package-lock.json"):
        raise Stop("E5 ranking source provenance missing")
    for name, digest in files.items():
        path = (rankings / name).resolve()
        if rankings.resolve() not in path.parents or not path.is_file() or sha(path) != digest:
            raise Stop("E5 ranking source provenance differs")

def verify_fixed_source(report: dict) -> None:
    if report.get("source_verification") != "per_question_hash":
        raise Stop("fixed-high source verification differs")

class State:
    def __init__(self, artifact: Path, script: Path, manifest: dict, pins: dict[str, Path]):
        artifact.mkdir(parents=True, exist_ok=True)
        self.state, self.log = artifact / f"longmemeval-adaptive-supervisor-{DAY}.state.json", artifact / f"longmemeval-adaptive-supervisor-{DAY}.log"
        self.freeze = artifact / f"longmemeval-adaptive-supervisor-{DAY}.manifest.json"
        payload = {
            "status": "frozen_before_adaptive_launch",
            "supervisor_sha256": sha(script),
            "candidate_archive_sha256": ARCHIVE_SHA,
            "candidate_manifest": manifest,
            "pinned_sha256": {name: sha(path) for name, path in pins.items()},
        }
        if not self.freeze.exists(): self.freeze.open("x").write(json.dumps(payload, indent=2))
        elif load(self.freeze) != payload: raise Stop("supervisor manifest differs")
        if not self.state.exists(): self.state.open("x").write(json.dumps({"status": "running", "stage": "initial"}))
        if not self.log.exists(): self.log.open("x").write("adaptive supervisor reserved\n")
    def stage(self, name: str, status: str) -> None:
        self.state.write_text(json.dumps({"status": status, "stage": name, "updated_at": time.time()}))
        with self.log.open("a") as file: file.write(f"{name}: {sanitize(status)}\n")
    def verify_pins(self, pins: dict[str, Path]) -> None:
        if {name: sha(path) for name, path in pins.items()} != load(self.freeze).get("pinned_sha256", {}):
            raise Stop("pinned artifact hash differs")

def preserve(out: Path, artifact: Path) -> None:
    for source in [out, Path(f"{out}.jsonl"), Path(f"{out}.progress.json")]:
        if not source.is_file(): raise Stop(f"artifact missing: {source.name}")
        target = artifact / source.name
        if target.exists() and sha(target) != sha(source): raise Stop("artifact collision")
        if not target.exists():
            with source.open("rb") as src, target.open("xb") as dst: shutil.copyfileobj(src, dst)

def preserve_complete(out: Path, artifact: Path) -> None:
    report = maybe(out)
    if report and report.get("status") == "complete": preserve(out, artifact)

def preserve_terminal_partial(out: Path, artifact: Path) -> None:
    sources = [path for path in [out, Path(f"{out}.jsonl"), Path(f"{out}.progress.json")] if path.is_file()]
    if not sources: return
    stamp = sha(sources[0])[:12]
    target_dir = artifact / "terminal-partials" / f"{out.name}-{stamp}"
    target_dir.mkdir(parents=True, exist_ok=True)
    for source in sources:
        target = target_dir / source.name
        if target.exists() and sha(target) != sha(source): raise Stop("terminal partial collision")
        if not target.exists():
            with source.open("rb") as src, target.open("xb") as dst: shutil.copyfileobj(src, dst)

def wait_terminal(out: Path, expected: list[str], expected_abs: set[str], expected_types: dict[str, str], **gates: object) -> dict:
    while True:
        running, report = live(out), maybe(out)
        if report and report.get("status") == "complete" and not running:
            verify(report, expected, expected_abs, expected_types, **gates)
            return report
        if not running:
            report = maybe(out)
            if report and report.get("status") == "complete":
                verify(report, expected, expected_abs, expected_types, **gates)
                return report
            raise Terminal(f"partial or invalid report without live producer: {out.name}")
        time.sleep(POLL)

def stage(state: State, name: str, root: Path, out: Path, input_path: Path, retrieval: str, rankings: Path | None, expected: list[str], expected_abs: set[str], expected_types: dict[str, str], artifact: Path, pins: dict[str, Path], **gates: object) -> dict:
    state.verify_pins(pins)
    archive(artifact / MANIFEST, root, ARCHIVE_SHA, {"full_input_sha256": data(root, FULL_INPUT)})
    process: subprocess.Popen | None = None
    try:
        paths = [out, Path(f"{out}.jsonl"), Path(f"{out}.progress.json")]
        if any(path.exists() for path in paths):
            report = wait_terminal(out, expected, expected_abs, expected_types, **gates)
        else:
            state.stage(name, "launching")
            log = artifact / f"{out.name}.run.log"
            try: handle = log.open("x")
            except FileExistsError as exc: raise Stop("stage log exists") from exc
            process = subprocess.Popen(command(out, input_path, retrieval, rankings), cwd=root, stdout=handle, stderr=subprocess.STDOUT); handle.close()
            while not live(out):
                exit_code = process.poll()
                if exit_code is not None:
                    report = maybe(out)
                    if exit_code == 0 and report and report.get("status") == "complete": break
                    if report and report.get("status") == "complete":
                        raise Stop(f"{name} producer exited {exit_code}")
                    raise Terminal(f"{name} producer exited {exit_code}")
                time.sleep(1)
            report = wait_terminal(out, expected, expected_abs, expected_types, **gates)
            if process.wait() != 0: raise Stop(f"{name} producer exited {process.returncode}")
        verify_invocation(report, root, out, input_path, retrieval, rankings, "adaptive")
        jsonl_equal(out, report); preserve(out, artifact); state.stage(name, "complete"); return report
    except Observation:
        raise
    except Terminal:
        preserve_terminal_partial(out, artifact)
        raise
    except Stop:
        preserve_complete(out, artifact)
        raise

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", type=Path)
    parser.add_argument("--fixed-high-dir", type=Path, required=True)
    parser.add_argument("--rankings-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, default=Path(__file__).resolve().parent / "data")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.candidate_dir is None:
        try: candidate_arg = Path(CANDIDATE_POINTER.read_text().strip())
        except OSError: parser.error(f"--candidate-dir is required when {CANDIDATE_POINTER} is unavailable")
    else: candidate_arg = args.candidate_dir
    candidate, fixed_root, rankings, artifact = candidate_arg.resolve(), args.fixed_high_dir.resolve(), args.rankings_dir.resolve(), args.artifact_dir.resolve()
    full, followup = data(candidate, FULL_INPUT), data(candidate, FOLLOWUP_INPUT)
    dev7rank, dev60rank = data(candidate, DEV7_RANK), data(candidate, DEV60_RANK)
    outputs = [data(candidate, name) for name in (DEV7, DEV60, FOLLOWUP, FULL)]
    if args.dry_run:
        print(json.dumps({"commands": [command(outputs[0], full, "cached", dev7rank), command(outputs[1], full, "cached", dev60rank), command(outputs[2], followup, "lexical"), command(outputs[3], full, "cached", data(rankings, "longmemeval-fresh-e5-full500-exact-2026-10-20.json"))]}, indent=2)); return 0
    state: State | None = None
    try:
        manifest = archive(artifact / MANIFEST, candidate, ARCHIVE_SHA, {"full_input_sha256": full})
        config = manifest.get("configuration", {})
        if manifest.get("status") != "frozen_before_adaptive_model_calls" or any(config.get(key) != value for key, value in {
            "provider": "qwen-local", "evidence": "highlighted", "evidence_policy": "system",
            "request_mode": "robust", "answer_check": "none", "reasoning_effort": "adaptive",
            "max_output_tokens": 16384, "context_chars": 180000, "top_k": 10, "planned_concurrency": 3,
        }.items()): raise Stop("adaptive manifest configuration differs")
        fixed_out = data(fixed_root, FIXED)
        full_doc, follow_doc = load(full), load(followup)
        full_ids, follow_ids = ids(full_doc), ids(follow_doc)
        full_abs, follow_abs = abstentions(full_doc, full_ids), abstentions(follow_doc, follow_ids)
        if len(full_ids) != 500 or len(full_abs) != 30 or len(follow_ids) != 100 or len(follow_abs) != 16:
            raise Stop("full or follow-up cohort counts differ")
        controls, follow_manifest = load(artifact / CONTROLS), load(artifact / FOLLOWUP_MANIFEST)
        if follow_manifest.get("status") != "locked_before_adaptive_model_calls": raise Stop("follow-up manifest differs")
        exact(ids(follow_manifest), follow_ids, "follow-up")
        if controls.get("previous_high", {}).get("correct") != 93 or controls.get("previous_high", {}).get("unanswerable", {}).get("correct") != 14 or follow_manifest.get("input_sha256") != sha(followup): raise Stop("follow-up controls differ")
        fixed60 = ids(load(artifact / FIXED60_MANIFEST))
        prior_validation = load(artifact / PRIOR_VALIDATION_MANIFEST).get("validation_ids")
        if not isinstance(prior_validation, list) or len(prior_validation) != len(set(prior_validation)):
            raise Stop("prior validation IDs differ")
        verify_followup(follow_manifest, full_doc, follow_doc, fixed60, prior_validation)
        routing = load(artifact / ROUTING_AUDIT)
        plan = routing.get("plan", [])
        if routing.get("status") != "complete" or routing.get("questions") != 60 or not routing.get("all_match_original_development_prompt_hashes") or not routing.get("legacy_occurrences_unambiguous") or routing.get("model_calls") != 0 or len(plan) != 60: raise Stop("routing audit differs")
        dev7ids, dev60ids = ids(load(dev7rank)), ids(load(dev60rank))
        if len(dev7ids) != 7 or set(dev7ids) != ORIGINAL7: raise Stop("development7 cohort differs")
        exact(dev60ids, fixed60, "development60")
        for path, selected in ((dev7rank, dev7ids), (dev60rank, dev60ids)):
            rank = load(path)
            if rank.get("status") != "complete" or rank.get("dataset_sha256") != full_doc.get("provenance", {}).get("dataset_sha256"):
                raise Stop("development ranking manifest differs")
        exact([row.get("question_id") for row in plan], dev60ids, "routing")
        if sum(row.get("reasoning_effort") == "high" for row in plan) != 19 or sum(row.get("reasoning_effort") == "low" for row in plan) != 41 or any(row.get("max_output_tokens") != 16384 for row in plan): raise Stop("routing plan differs")
        e5rank = data(rankings, "longmemeval-fresh-e5-full500-exact-2026-10-20.json")
        verify_e5(load(e5rank), full_ids, full_doc, rankings, artifact)
        fixed_source = archive(artifact / FIXED_SOURCE_MANIFEST, fixed_root, FIXED_SOURCE_ARCHIVE_SHA)
        if fixed_source.get("status") != "reconstructed_exact_source_bundle":
            raise Stop("fixed-high source manifest differs")
        pins = {
            "candidate_manifest": artifact / MANIFEST, "full_input": full, "followup_input": followup,
            "dev7_rankings": dev7rank, "dev60_rankings": dev60rank, "routing_audit": artifact / ROUTING_AUDIT,
            "followup_manifest": artifact / FOLLOWUP_MANIFEST, "followup_controls": artifact / CONTROLS,
            "fixed60_manifest": artifact / FIXED60_MANIFEST, "prior_validation_manifest": artifact / PRIOR_VALIDATION_MANIFEST,
            "fixed_high_input": data(fixed_root, FULL_INPUT),
            "fixed_source_manifest": artifact / FIXED_SOURCE_MANIFEST, "fixed_source_archive": artifact / FIXED_SOURCE_ARCHIVE,
            "fresh_e5_rankings": e5rank, "fresh_e5_manifest": artifact / RANKINGS_MANIFEST,
            "fresh_e5_archive": artifact / RANKINGS_ARCHIVE,
            "protocol": Path(__file__).with_name("LONGMEMEVAL-IMPROVEMENT-PROTOCOL.md"),
        }
        state = State(artifact, Path(__file__), manifest, pins)
        state.stage("waiting-fixed-high", "waiting")
        try: fixed = wait_terminal(fixed_out, full_ids, full_abs, types(full_doc, full_ids))
        except Observation:
            raise
        except Terminal:
            preserve_terminal_partial(fixed_out, artifact)
            raise
        except Stop:
            preserve_complete(fixed_out, artifact)
            raise
        state.verify_pins(pins)
        archive(artifact / MANIFEST, candidate, ARCHIVE_SHA, {"full_input_sha256": full})
        verify_e5(load(e5rank), full_ids, full_doc, rankings, artifact)
        archive(artifact / FIXED_SOURCE_MANIFEST, fixed_root, FIXED_SOURCE_ARCHIVE_SHA)
        verify_fixed_source(fixed)
        verify_invocation(fixed, fixed_root, fixed_out, data(fixed_root, FULL_INPUT), "cached", e5rank, "high")
        jsonl_equal(fixed_out, fixed); preserve(fixed_out, artifact)
        stage(state, "development7", candidate, outputs[0], full, "cached", dev7rank, dev7ids, abstentions(full_doc, dev7ids), types(full_doc, dev7ids), artifact, pins)
        stage(state, "development60", candidate, outputs[1], full, "cached", dev60rank, dev60ids, abstentions(full_doc, dev60ids), types(full_doc, dev60ids), artifact, pins, minimum=58, original7=True)
        stage(state, "followup100", candidate, outputs[2], followup, "lexical", None, follow_ids, follow_abs, types(follow_doc, follow_ids), artifact, pins, minimum=93, abs_minimum=14)
        fixed_correct, fixed_abs = verify(fixed, full_ids, full_abs, types(full_doc, full_ids))
        stage(state, "full500", candidate, outputs[3], full, "cached", e5rank, full_ids, full_abs, types(full_doc, full_ids), artifact, pins, minimum=max(446, fixed_correct), abs_minimum=max(27, fixed_abs), preferences=25, original7=True)
        state.stage("complete", "complete"); return 0
    except Observation as error:
        if state: state.stage("observation-error", sanitize(error))
        print(f"observation error: {sanitize(error)}", file=sys.stderr); return 3
    except Stop as error:
        if state: state.stage("failed", sanitize(error))
        print(f"stopped: {sanitize(error)}", file=sys.stderr); return 2

if __name__ == "__main__": raise SystemExit(main())
