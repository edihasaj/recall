#!/usr/bin/env python3
"""Fail-closed supervisor for the fresh LongMemEval additive-evidence paired trial.

See LONGMEMEVAL-ADDITIVE-TRIAL-PROTOCOL.md. A fresh 100-question cohort (all 30
unanswerable questions as a safety stratum plus the first 70 answerable ones by
seeded hash) is answered twice: control with supplemental evidence, candidate
with additive evidence. Both arms use adaptive initial reasoning. The default
mode only prepares the frozen selection, per-question effort policy, block
inputs, schedule and digest inventory (no model calls). `--live` runs the
sequential stages through `dgx run`. No retries, no rejudging. DGX_KEY_FILE is
inherited from the environment and required only for live runs. This trial
overrepresents unanswerable questions, claims no full500 score and leaves the
public 472/500 result unchanged.
"""
from __future__ import annotations

import argparse, hashlib, json, os, shutil, subprocess, sys, time, types
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

SEED = "recall-longmemeval-additive-2026-10-23-v1"
BASELINE_SHA = "9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0"
ABSTENTIONS, ANSWERABLE, BLOCK, ORIGINAL_SOURCES = 30, 70, 3, 20
PROTOCOL_NAME = "LONGMEMEVAL-ADDITIVE-TRIAL-PROTOCOL.md"
POLICY_TS = "benchmark/longmemeval-inference-policy.ts"
EFFORT_JS = """import {readFileSync} from "node:fs"; import {resolve} from "node:path"; import {pathToFileURL} from "node:url";
const {resolveReasoningEffort: adaptive} = await import(pathToFileURL(resolve(%r)).href);
const rows = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify(Object.fromEntries(rows.map(r => [r.id, adaptive("adaptive", r.question)]))));
""" % POLICY_TS
BASELINE = "longmemeval-full500-longer-timeout-2026-10-23.json"
INPUT = "longmemeval-amb-input-2026-10-19.json"
RANKINGS = "longmemeval-fresh-e5-full500-exact-2026-10-20.json"
EVIDENCE = {"control": "supplemental", "candidate": "additive"}
COMMON = {"--top-k": "20", "--context-chars": "180000", "--evidence-policy": "system", "--answer-policy": "minimal",
          "--answer-check": "premise", "--answer-recovery": "longer-timeout-transport", "--provider": "qwen-local",
          "--request-mode": "robust", "--max-output-tokens": "16384", "--concurrency": "3", "--reasoning-effort": "adaptive"}
INVOCATION = {"--top-k": "topK", "--context-chars": "contextChars", "--evidence": "evidence", "--evidence-policy": "evidencePolicy",
              "--answer-policy": "answerPolicy", "--answer-check": "answerCheck", "--answer-recovery": "answerRecovery",
              "--provider": "provider", "--request-mode": "requestMode", "--max-output-tokens": "maxOutputTokens",
              "--concurrency": "concurrency", "--reasoning-effort": "reasoningEffort"}
TREE_ROOTS = ("src", "benchmark", "drizzle", "node_modules")
TREE_FILES = ("package.json", "package-lock.json", "tsconfig.json")
SKIP_DIRS = {"benchmark/data"}
MODEL, ANSWER_TOKENS, CHECK_TOKENS = "qwen3.8-flash-next", 16384, 4096
LOWER = {"high": "low", "medium": "low", "low": "none"}  # recovery after response_not_completed
Runner = Callable[..., int]
VALIDATION = Path(__file__).resolve().with_name("longmemeval_additive_validation.py")
V = types.ModuleType("longmemeval_additive_validation")
exec(compile(VALIDATION.read_text(), str(VALIDATION), "exec"), V.__dict__)  # exec, not import: no bytecode beside the frozen tree
_physical, usage, evidence_problems = V.physical, V.usage, V.evidence_problems


class Failure(Exception):
    def __init__(self, status: str, code: int, detail: Any = None):
        super().__init__(status)
        self.status, self.code, self.detail = status, code, detail


def now() -> str: return datetime.now(timezone.utc).isoformat()
def load(p: Path) -> Any: return json.loads(Path(p).read_text())
def canon(x: Any) -> str: return hashlib.sha256(json.dumps(x, sort_keys=True).encode()).hexdigest()
def hkey(q: str) -> str: return hashlib.sha256(SEED.encode() + b"\0" + q.encode()).hexdigest()


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with Path(p).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()


def entry(p: Path) -> str:
    return "link:" + os.readlink(p) if p.is_symlink() else sha(p) if p.is_file() else "special"


def write_json(p: Path, data: Any, exclusive: bool = False) -> None:
    if exclusive:
        with p.open("x") as f: f.write(json.dumps(data, indent=1) + "\n")
        return
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1) + "\n")
    os.replace(tmp, p)


def derive_selection(cases: list[dict]) -> dict[str, list[str]]:
    """All unanswerable IDs plus the first 70 answerable IDs by SHA256(seed NUL id). Only the ID and the
    abstention flag are read: correctness, references and gold sessions never influence the cohort."""
    ids = [c["question_id"] for c in cases]
    if len(set(ids)) != len(ids): raise Failure("duplicate_input_ids", 2)
    if any(not isinstance(c.get("is_abstention"), bool) for c in cases): raise Failure("abstention_flag_not_boolean", 2)
    abstain = sorted((c["question_id"] for c in cases if c["is_abstention"]), key=hkey)
    answerable = sorted((c["question_id"] for c in cases if not c["is_abstention"]), key=hkey)
    if len(abstain) != ABSTENTIONS or len(answerable) < ANSWERABLE:
        raise Failure("cohort_count_mismatch", 2, {"abstention": len(abstain), "answerable": len(answerable)})
    return {"abstention_ids": abstain, "answerable_ids": answerable[:ANSWERABLE],
            "selected_question_ids": sorted(abstain + answerable[:ANSWERABLE], key=hkey)}


def derive_efforts(a: argparse.Namespace, cases: list[dict], ids: list[str]) -> dict[str, str]:
    """Native initial effort for each original question, from the frozen source's adaptive resolver."""
    by = {c["question_id"]: c["question"] for c in cases}
    rows = [{"id": q, "question": by[q]} for q in ids]
    try:
        r = subprocess.run([str(a.node), "--import", "tsx", "--input-type=module", "-e", EFFORT_JS], cwd=a.source_root,
                           input=json.dumps(rows), capture_output=True, text=True, timeout=300)
        got = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as e: raise Failure("effort_derivation_failed", 2, repr(e))
    if r.returncode or not isinstance(got, dict) or set(got) != set(ids) or not set(got.values()) <= {"high", "low"}:
        raise Failure("effort_derivation_failed", 2, {"exit": r.returncode, "stderr": r.stderr[-500:]})
    return {q: got[q] for q in ids}


def schedule(ids: list[str], size: int = ABSTENTIONS + ANSWERABLE) -> list[dict]:
    """Groups of BLOCK (the final one may be partial); even blocks control then candidate, odd blocks reverse."""
    if len(ids) != size or len(set(ids)) != size: raise Failure("bad_selection_size", 2)
    stages: list[dict] = []
    for b in range(-(-size // BLOCK)):
        for arm in (("control", "candidate") if b % 2 == 0 else ("candidate", "control")):
            stages.append({"index": len(stages), "block": b, "arm": arm, "ids": ids[b * BLOCK:(b + 1) * BLOCK]})
    return stages


def subset_input(data: dict, ids: list[str], parent_sha: str) -> dict:
    by = {c["question_id"]: c for c in data["cases"]}
    return {**data, "cases": [by[q] for q in ids], "trial_subset": {"parent_sha256": parent_sha}}


def subset_rankings(data: dict, ids: list[str], parent_sha: str) -> dict:
    by = {r["question_id"]: r for r in data["results"]}
    return {**data, "selected_question_ids": list(ids), "results": [by[q] for q in ids], "trial_subset": {"parent_sha256": parent_sha}}


def manifest(a: argparse.Namespace) -> dict[str, str]:
    """Path, symlink target and digest of every file the run depends on, excluding benchmark/data."""
    root, m = a.source_root, {}
    for rel in TREE_ROOTS:
        if not (root / rel).is_dir(): raise Failure("source_tree_missing", 2, rel)
        for d, dirs, files in os.walk(root / rel):
            keep = []
            for x in sorted(dirs):
                p = Path(d, x)
                r = p.relative_to(root).as_posix()
                if r in SKIP_DIRS: continue
                if p.is_symlink(): m["src:" + r] = entry(p)
                else: keep.append(x)
            dirs[:] = keep
            for x in sorted(files):
                p = Path(d, x)
                m["src:" + p.relative_to(root).as_posix()] = entry(p)
    for f in (*TREE_FILES, "pnpm-lock.yaml"):
        if (root / f).is_file(): m["src:" + f] = sha(root / f)
        elif f in TREE_FILES: raise Failure("source_file_missing", 2, f)
    blocks = a.out_dir / "blocks"
    for p in sorted(blocks.rglob("*")) if blocks.is_dir() else []:
        if p.is_file() or p.is_symlink(): m["block:" + p.relative_to(blocks).as_posix()] = entry(p)
    pinned = {"node": a.node, "python": Path(sys.executable), "protocol": a.protocol, "supervisor": Path(__file__), "validation": VALIDATION,
              "selection": a.out_dir / "selection.json", "efforts": a.out_dir / "efforts.json",
              "baseline": a.data_dir / BASELINE, "input": a.data_dir / INPUT, "rankings": a.data_dir / RANKINGS}
    for key, p in pinned.items(): m[key] = sha(Path(p).resolve())
    return m


def verify_manifest(a: argparse.Namespace, want: dict[str, str]) -> None:
    got = manifest(a)
    bad = sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))
    if bad: raise Failure("inventory_mismatch", 3, {"count": len(bad), "first": bad[:20]})


def arm_flags(arm: str) -> dict[str, str]: return {**COMMON, "--evidence": EVIDENCE[arm]}


def stage_command(a: argparse.Namespace, arm: str, inp: Path, rank: Path, out: Path) -> list[str]:
    return ["dgx", "run", "--", str(a.node), "--import", "tsx", "benchmark/longmemeval-qa.ts",
            "--input", str(inp), "--retrieval", "cached", "--rankings", str(rank),
            *[x for kv in arm_flags(arm).items() for x in kv], "--out", str(out)]


def _config_problems(row: dict, first: str) -> list[str]:
    """Recorded settings must match this question's native initial effort, the recovery policy and the fixed check/judge settings."""
    out: list[str] = []

    def expect(label: str, call: Any, effort: str, tokens: int) -> None:
        want = {"reasoning_effort": effort, "max_output_tokens": tokens}
        if not isinstance(call, dict): return
        got = call.get("request_config")
        if isinstance(got, dict) and label.endswith("answer_call") and got.get("requested_reasoning_effort") == "adaptive":
            got = {k: v for k, v in got.items() if k != "requested_reasoning_effort"}
        if got != want: out.append(f"{label} config {call.get('request_config')} want {want}")
    ac, fc = row.get("answer_call"), row.get("failed_answer_call")
    expect("premise_call", row.get("premise_call"), "low", CHECK_TOKENS)
    expect("judge_call", row.get("judge_call"), "none", CHECK_TOKENS)
    if fc is None:
        expect("answer_call", ac, first, ANSWER_TOKENS)
        if row.get("answer_recovered") is not None: out.append("answer_recovered set without a failed call")
    elif isinstance(fc, dict):
        expect("failed_answer_call", fc, first, ANSWER_TOKENS)
        if fc.get("error") not in ("timeout", "response_not_completed"): out.append(f"failed_answer_call.error={fc.get('error')} is not retryable")
        expect("answer_call", ac, first if fc.get("error") == "timeout" else LOWER[first], ANSWER_TOKENS)
        if row.get("answer_recovered") is not True: out.append("answer_recovered is not true after a retry")
    else: out.append("failed_answer_call malformed")
    for key in ("answer_call", "failed_answer_call", "premise_call", "judge_call"):
        top = row.get(key)
        if not isinstance(top, dict): continue
        if "transport_failures" in top and not isinstance(top["transport_failures"], list): out.append(f"{key}.transport_failures malformed")
        if len(top.get("transport_failures") or []) > 3: out.append(f"{key} has more than 3 transport retries")
        for label, c, parent in _physical(top, key):
            if c.get("model") != MODEL: out.append(f"{label} model {c.get('model')} want {MODEL}")
            if parent is not None and (c.get("error") != "request_failed" or c.get("request_config") != parent.get("request_config")
                                       or c.get("prompt_sha256") != parent.get("prompt_sha256")):
                out.append(f"{label} is not a same-settings request_failed retry")
    return out


def _row_problems(row: dict, arm: str, first: str) -> list[str]:
    out = []
    for key in ("answer_call", "premise_call", "judge_call"):
        c = row.get(key)
        if not isinstance(c, dict): out.append(f"{key} missing"); continue
        if c.get("error") is not None: out.append(f"{key}.error={c['error']}")
    ac = row.get("answer_call")
    if isinstance(ac, dict) and not (isinstance(ac.get("prompt_sha256"), str) and ac["prompt_sha256"]): out.append("answer prompt hash missing")
    if not isinstance(row.get("premise_recorded"), bool): out.append("premise_recorded not boolean")
    failed = row.get("failed_answer_call")
    if isinstance(failed, dict) and isinstance(ac, dict) and failed.get("prompt_sha256") != ac.get("prompt_sha256"):
        out.append("recovered call prompt hash differs")
    return out + evidence_problems(row, arm) + _config_problems(row, first)


def check_rows(rows: list[dict], ids: list[str], abs_ids: set[str], arm: str, init: dict[str, str]) -> list[str]:
    got = [r.get("question_id") for r in rows]
    problems: list[str] = []
    if sorted(map(str, got)) != sorted(ids):  # also rejects duplicates
        problems.append(f"ids wrong: missing={sorted(set(ids) - set(got))} extra={sorted(set(map(str, got)) - set(ids))} count={len(got)}")
    for r in rows:
        q = r.get("question_id")
        if r.get("error"): problems.append(f"{q}: row error {r['error']}")
        if not isinstance(r.get("correct"), bool): problems.append(f"{q}: correct is not boolean")
        if q in ids and bool(r.get("is_abstention")) != (q in abs_ids): problems.append(f"{q}: abstention flag differs from frozen input")
        if q not in init: continue
        problems += [f"{q}: {p}" for p in _row_problems(r, arm, init[q])]
    return problems


def check_report(report: dict, ids: list[str], abs_ids: set[str], arm: str, init: dict[str, str], expect: dict[str, str]) -> list[str]:
    problems = [] if report.get("status") == "complete" else [f"report status {report.get('status')}"]
    if report.get("comparison_valid") is not True: problems.append(f"comparison_valid is {report.get('comparison_valid')}, not true")
    inv, s, flags = report.get("invocation") or {}, report.get("summary") or {}, arm_flags(arm)
    for flag, key in INVOCATION.items():
        if str(inv.get(key)) != flags[flag]: problems.append(f"invocation {key}={inv.get(key)} want {flags[flag]}")
    for key, want in {**expect, "retrieval": "cached"}.items():
        if inv.get(key) != want: problems.append(f"invocation {key} differs")
    if s.get("errors") != 0 or s.get("planned") != len(ids) or s.get("recorded") != len(ids):
        problems.append(f"summary not clean: errors={s.get('errors')} planned={s.get('planned')} recorded={s.get('recorded')}")
    return problems + check_rows(report.get("results") or [], ids, abs_ids, arm, init)


def _get(rows: dict[str, dict], q: str, *path: str) -> Any:
    v: Any = rows.get(q)
    for p in path: v = v.get(p) if isinstance(v, dict) else None
    return v


def parity_problems(control: dict | None, candidate: dict | None) -> list[str]:
    """The candidate's base prefix must equal the control's evidence text exactly and its first twenty sources the control's metadata."""
    ce, ke = (control or {}).get("evidence"), (candidate or {}).get("evidence")
    if not (isinstance(ce, dict) and isinstance(ke, dict)): return ["evidence missing"]
    ct, kt, add, cs, ks = ce.get("text"), ke.get("text"), ke.get("additive"), ce.get("sources"), ke.get("sources")
    out = []
    base = add.get("base_chars") if isinstance(add, dict) else None
    units = len(ct.encode("utf-16-le", "surrogatepass")) // 2 if isinstance(ct, str) else None  # TS base_chars counts UTF-16 units
    if not (isinstance(ct, str) and ct and isinstance(kt, str) and type(base) is int and base == units and kt.startswith(ct)):
        out.append("candidate base prefix differs from control evidence")
    if not (isinstance(cs, list) and len(cs) == ORIGINAL_SOURCES and isinstance(ks, list) and ks[:ORIGINAL_SOURCES] == cs):
        out.append("candidate first 20 sources differ from control metadata")
    return out


def compare(ids: list[str], control: dict[str, dict], candidate: dict[str, dict], abs_ids: set[str], init: dict[str, str],
            instructions: dict[str, set] | None = None) -> dict:
    """Numerical screen only. Answer prompts intentionally differ because the evidence differs, so they are recorded, not compared."""
    ok = lambda rows, q: _get(rows, q, "correct") is True
    gains = [q for q in ids if not ok(control, q) and ok(candidate, q)]
    losses = [q for q in ids if ok(control, q) and not ok(candidate, q)]
    abs_losses = [q for q in losses if q in abs_ids]
    parity = {q: p for q in ids if (p := parity_problems(control.get(q), candidate.get(q)))}
    c_ok, k_ok = sum(ok(control, q) for q in ids), sum(ok(candidate, q) for q in ids)
    complete = (len(control) == len(candidate) == len(ids) and not check_rows(list(control.values()), ids, abs_ids, "control", init)
                and not check_rows(list(candidate.values()), ids, abs_ids, "candidate", init))
    same = bool(instructions) and all(len(instructions.get(arm) or ()) == 1 for arm in ("control", "candidate")) and instructions["control"] == instructions["candidate"]
    checks = {"all_rows_present_error_free": complete, "net_gain_at_least_2": k_ok - c_ok >= 2, "no_abstention_pair_loss": not abs_losses,
              "base_prefix_and_source_parity": not parity, "answer_instructions_match": same}
    return {"advancement_screen_passed": all(checks.values()), "checks": checks, "control_correct": c_ok, "candidate_correct": k_ok,
            "net": k_ok - c_ok, "gains": gains, "losses": losses, "abstention_losses": abs_losses,
            "abstention_pairs": {q: {"control": ok(control, q), "candidate": ok(candidate, q)} for q in ids if q in abs_ids},
            "prefix_or_source_parity_failures": parity,
            "answer_prompt_sha256": {q: {"control": _get(control, q, "answer_call", "prompt_sha256"),
                                         "candidate": _get(candidate, q, "answer_call", "prompt_sha256")} for q in ids},
            "source_review": {"required": True, "status": "pending", "gains": gains, "losses": losses}}


def default_runner(cmd: list[str], cwd: Path, env: dict, stdout: Any, stderr: Any) -> int:
    return subprocess.run(cmd, cwd=cwd, env=env, stdout=stdout, stderr=stderr).returncode


def run_stage(a: argparse.Namespace, s: dict, st: dict, inv: dict, abs_ids: set[str], init: dict[str, str], runner: Runner,
              save: Callable[[], None]) -> list[dict]:
    out = a.out_dir
    rec = st["stages"][s["index"]] = {"arm": s["arm"], "block": s["block"], "status": "verifying"}
    save()
    verify_manifest(a, inv)
    d = out / "stages" / f"{s['index']:02d}-{s['arm']}"
    d.mkdir()
    report, bdir = d / "report.json", out / "blocks" / f"block-{s['block']}"
    rec.update(status="running", started_at=now(), command=s["cmd"])
    save()
    t0 = time.monotonic()
    with (d / "stdout.log").open("xb") as so, (d / "stderr.log").open("xb") as se:
        code = runner(s["cmd"], a.source_root, dict(os.environ), so, se)
    rec.update(finished_at=now(), wall_seconds=round(time.monotonic() - t0, 1), exit_code=code)
    rec["stdout_sha256"], rec["stderr_sha256"] = sha(d / "stdout.log"), sha(d / "stderr.log")
    for key, suffix in (("jsonl_sha256", ".jsonl"), ("progress_sha256", ".progress.json")):
        if Path(f"{report}{suffix}").exists(): rec[key] = sha(Path(f"{report}{suffix}"))
    if not report.exists():
        rec["status"] = "no_report"
        raise Failure("stage_no_report", 5, {"stage": s["index"], "exit_code": code})
    rec["report_sha256"] = sha(report)
    try: rep = load(report)
    except ValueError:
        rec["status"] = "invalid_json"
        raise Failure("stage_report_unparseable", 6, {"stage": s["index"]})
    expect = {"input": str(bdir / "input.json"), "rankings": str(bdir / "rankings.json"), "out": str(report)}
    problems = (["nonzero exit %s" % code] if code else []) + check_report(rep, s["ids"], abs_ids, s["arm"], init, expect)
    instr = rep.get("answer_instructions")
    if isinstance(instr, dict) and isinstance(instr.get("sha256"), str):
        rec["answer_instructions_sha256"] = canon(instr)
        if rec["answer_instructions_sha256"] != st.setdefault("answer_instructions_sha256", rec["answer_instructions_sha256"]):
            problems.append("answer_instructions differ from the first stage")
    else: problems.append("answer_instructions missing")
    if problems:
        rec.update(status="invalid", problems=problems[:50])
        raise Failure("stage_failed" if code else "stage_invalid", 5 if code else 6, {"stage": s["index"], "problems": problems[:10]})
    rec["status"] = "valid"
    save()
    return rep["results"]


def execute(a: argparse.Namespace, st: dict, save: Callable[[], None], runner: Runner | None) -> int:
    out = a.out_dir
    if sha(a.data_dir / BASELINE) != BASELINE_SHA: raise Failure("baseline_mismatch", 2)
    baseline = load(a.data_dir / BASELINE)
    in_sha, rank_sha = sha(a.data_dir / INPUT), sha(a.data_dir / RANKINGS)
    bound = baseline.get("hashes") or {}  # the baseline run recorded the exact input and rankings it consumed
    if in_sha != bound.get("input") or rank_sha != bound.get("rankings"):
        raise Failure("input_or_rankings_not_baseline_bound", 2, {"input": in_sha, "rankings": rank_sha, "baseline": {k: bound.get(k) for k in ("input", "rankings")}})
    inp, rank = load(a.data_dir / INPUT), load(a.data_dir / RANKINGS)
    sel = derive_selection(inp["cases"])
    ids, abs_ids = sel["selected_question_ids"], set(sel["abstention_ids"])
    write_json(out / "selection.json", {
        "seed": SEED, "stratum": "abstention-only safety stratum; no correctness or gold reference is read",
        "rule": "all abstention cases plus the first 70 answerable cases by SHA256(seed NUL id); combined list sorted by the same hash",
        "count": len(ids), "abstention_count": len(abs_ids), "answerable_count": len(sel["answerable_ids"]), **sel,
        "input_sha256": in_sha, "rankings_sha256": rank_sha, "baseline_sha256": BASELINE_SHA, "recorded_at": now()}, exclusive=True)
    if not set(ids) <= {r["question_id"] for r in rank["results"]}: raise Failure("selected_ids_missing_from_rankings", 2)
    init = derive_efforts(a, inp["cases"], ids)
    write_json(out / "efforts.json", {"policy": POLICY_TS, "policy_sha256": sha(a.source_root / POLICY_TS), "initial_effort": init}, exclusive=True)
    stages = schedule(ids)
    (out / "blocks").mkdir()
    for b in range(-(-len(ids) // BLOCK)):
        block_ids, d = ids[b * BLOCK:(b + 1) * BLOCK], out / "blocks" / f"block-{b}"
        d.mkdir()
        write_json(d / "input.json", subset_input(inp, block_ids, in_sha), True)
        write_json(d / "rankings.json", subset_rankings(rank, block_ids, rank_sha), True)
    inv = manifest(a)  # taken after generation, so it includes the block files every stage consumes
    write_json(out / "inventory.json", inv, exclusive=True)
    for s in stages:
        d = out / "blocks" / f"block-{s['block']}"
        s["cmd"] = stage_command(a, s["arm"], d / "input.json", d / "rankings.json", out / "stages" / f"{s['index']:02d}-{s['arm']}" / "report.json")
    st.update(selected_question_ids=ids, abstention_ids=sorted(abs_ids), initial_effort=init, inventory_sha256=canon(inv), inventory_files=len(inv),
              python=sys.version, hashes={k: inv[k] for k in ("supervisor", "validation", "protocol", "selection", "efforts", "baseline", "input", "rankings", "node", "python")},
              block_sha256={k: v for k, v in inv.items() if k.startswith("block:")},
              schedule=[{k: s[k] for k in ("index", "block", "arm")} for s in stages], stages={}, cohort_size=len(ids),
              claim="Exploratory fresh 100-question paired additive-evidence trial that overrepresents the 30 unanswerable questions; "
                    "not a full500 score; the public 472/500 result is unchanged.")
    if not a.live:
        st.update(status="prepared", finished_at=now(), planned_commands=[s["cmd"] for s in stages])
        save()
        return 0
    if not os.environ.get("DGX_KEY_FILE"): raise Failure("dgx_key_file_unset", 7)
    if runner is None and not shutil.which("dgx"): raise Failure("dgx_unavailable", 7)
    st["status"] = "running"
    (out / "stages").mkdir()
    rows: dict[str, dict[str, dict]] = {"control": {}, "candidate": {}}
    for s in stages:
        results = run_stage(a, s, st, inv, abs_ids, init, runner or default_runner, save)
        rows[s["arm"]].update({r["question_id"]: r for r in results})
    verify_manifest(a, inv)
    instr = {arm: {r.get("answer_instructions_sha256") for r in st["stages"].values() if r["arm"] == arm} for arm in rows}
    result = compare(ids, rows["control"], rows["candidate"], abs_ids, init, instr)
    result.update(usage={arm: usage(list(r.values())) for arm, r in rows.items()}, selected_question_ids=ids, claim=st["claim"],
                  strata={"abstention": len(abs_ids), "answerable": len(ids) - len(abs_ids)},
                  answer_instructions_sha256=st.get("answer_instructions_sha256"),
                  status="pending_source_review" if result["advancement_screen_passed"] else "screen_not_passed",
                  stage_report_sha256={str(i): s["report_sha256"] for i, s in st["stages"].items()})
    write_json(out / "result.json", result, exclusive=True)
    st.update(status=result["status"], advancement_screen_passed=result["advancement_screen_passed"], result_sha256=sha(out / "result.json"), finished_at=now())
    save()
    return 0


def parse(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    for flag in ("source-root", "data-dir", "node", "out-dir", "protocol"): p.add_argument("--" + flag, type=Path, required=True)
    p.add_argument("--live", action="store_true", default=False)
    a = p.parse_args(argv)
    if a.protocol.name != PROTOCOL_NAME: p.error(f"--protocol must be {PROTOCOL_NAME}")
    for k in ("source_root", "data_dir", "node", "out_dir", "protocol"): setattr(a, k, getattr(a, k).absolute())
    if not a.protocol.is_file(): p.error(f"--protocol file not found: {a.protocol}")
    return a


def main(argv: list[str] | None = None, runner: Runner | None = None) -> int:
    a = parse(argv)
    if a.out_dir.resolve().is_relative_to(a.source_root.resolve()):
        print(f"out_dir_inside_source_root: {a.out_dir}", file=sys.stderr)
        return 2
    a.out_dir.parent.mkdir(parents=True, exist_ok=True)
    try: a.out_dir.mkdir()
    except FileExistsError:
        print(f"output_exists: {a.out_dir}", file=sys.stderr)
        return 4
    st: dict[str, Any] = {"started_at": now(), "status": "preparing", "mode": "live" if a.live else "prepare",
                          "source_root": str(a.source_root), "out_dir": str(a.out_dir)}
    save = lambda: write_json(a.out_dir / "state.json", st)
    save()
    try: return execute(a, st, save, runner)
    except Failure as e:
        st.update(status=e.status, detail=e.detail, finished_at=now())
        save()
        print(f"{e.status}: {e.detail}", file=sys.stderr)
        return e.code
    except Exception as e:  # fail closed on any unexpected error
        st.update(status="error", detail=repr(e), finished_at=now())
        save()
        print(f"error: {e!r}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
