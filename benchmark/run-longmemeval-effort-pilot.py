#!/usr/bin/env python3
"""Fail-closed supervisor for the LongMemEval paired answer-effort pilot.

See LONGMEMEVAL-EFFORT-PILOT-PROTOCOL.md. The default mode only prepares the
frozen selection, block inputs, schedule and digest inventory (no model calls).
`--live` runs the 16 sequential stages through `dgx run`. No retries, no
rejudging. DGX_KEY_FILE is inherited from the environment and required only for
live runs.
"""
from __future__ import annotations

import argparse, hashlib, json, os, shutil, subprocess, sys, time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

SEED = "recall-longmemeval-effort-2026-10-23-v1"
BASELINE_SHA = "9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0"
EXPECTED_LOW, SIZE, BLOCK = 321, 24, 3
BASELINE = "longmemeval-full500-longer-timeout-2026-10-23.json"
INPUT = "longmemeval-amb-input-2026-10-19.json"
RANKINGS = "longmemeval-fresh-e5-full500-exact-2026-10-20.json"
EFFORT = {"control": "adaptive", "candidate": "high"}
COMMON = {"--top-k": "20", "--context-chars": "180000", "--evidence": "supplemental",
          "--evidence-policy": "system", "--answer-policy": "minimal", "--answer-check": "premise",
          "--answer-recovery": "longer-timeout-transport", "--provider": "qwen-local",
          "--request-mode": "robust", "--max-output-tokens": "16384", "--concurrency": "3"}
INVOCATION = {"--top-k": "topK", "--context-chars": "contextChars", "--evidence": "evidence",
              "--evidence-policy": "evidencePolicy", "--answer-policy": "answerPolicy",
              "--answer-check": "answerCheck", "--answer-recovery": "answerRecovery",
              "--provider": "provider", "--request-mode": "requestMode",
              "--max-output-tokens": "maxOutputTokens", "--concurrency": "concurrency",
              "--reasoning-effort": "reasoningEffort"}
TREE_ROOTS = ("src", "benchmark", "drizzle", "node_modules")
TREE_FILES = ("package.json", "package-lock.json", "tsconfig.json")
SKIP_DIRS = {"benchmark/data"}
MODEL, ANSWER_TOKENS, CHECK_TOKENS = "qwen3.8-flash-next", 16384, 4096
# Every pilot question is a baseline-low question, so adaptive effort always starts at low.
INITIAL = {"control": "low", "candidate": "high"}
LOWER = {"high": "low", "medium": "low", "low": "none"}
Runner = Callable[..., int]


class Failure(Exception):
    def __init__(self, status: str, code: int, detail: Any = None):
        super().__init__(status)
        self.status, self.code, self.detail = status, code, detail


def now() -> str: return datetime.now(timezone.utc).isoformat()
def load(p: Path) -> Any: return json.loads(Path(p).read_text())
def canon(x: Any) -> str: return hashlib.sha256(json.dumps(x, sort_keys=True).encode()).hexdigest()


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


def derive_selection(rows: list[dict], seed: str | None = None, size: int | None = None, expected_low: int | None = None) -> list[str]:
    """First `size` low-effort baseline IDs by SHA256(seed NUL id); correctness is never read."""
    seed, size, expected_low = seed or SEED, size or SIZE, expected_low or EXPECTED_LOW
    low = [r["question_id"] for r in rows
           if ((r.get("answer_call") or {}).get("request_config") or {}).get("reasoning_effort") == "low"]
    if len(low) != expected_low or len(set(low)) != len(low):
        raise Failure("baseline_low_count_mismatch", 2, {"found": len(low), "expected": expected_low})
    return sorted(low, key=lambda q: hashlib.sha256(seed.encode() + b"\0" + q.encode()).hexdigest())[:size]


def schedule(ids: list[str]) -> list[dict]:
    """Eight blocks; even blocks control then candidate, odd blocks candidate then control."""
    if len(ids) != SIZE or len(set(ids)) != SIZE: raise Failure("bad_selection_size", 2)
    stages: list[dict] = []
    for b in range(SIZE // BLOCK):
        for arm in (("control", "candidate") if b % 2 == 0 else ("candidate", "control")):
            stages.append({"index": len(stages), "block": b, "arm": arm, "ids": ids[b * BLOCK:(b + 1) * BLOCK]})
    return stages


def subset_input(data: dict, ids: list[str], parent_sha: str) -> dict:
    by = {c["question_id"]: c for c in data["cases"]}
    return {**data, "cases": [by[q] for q in ids], "pilot_subset": {"parent_sha256": parent_sha}}


def subset_rankings(data: dict, ids: list[str], parent_sha: str) -> dict:
    by = {r["question_id"]: r for r in data["results"]}
    return {**data, "selected_question_ids": list(ids), "results": [by[q] for q in ids], "pilot_subset": {"parent_sha256": parent_sha}}


def manifest(a: argparse.Namespace) -> dict[str, str]:
    """Digest of every file the run depends on, excluding benchmark/data."""
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
    blocks = a.out_dir / "blocks"  # generated inputs consumed by every stage
    for p in sorted(blocks.rglob("*")) if blocks.is_dir() else []:
        if p.is_file() or p.is_symlink(): m["block:" + p.relative_to(blocks).as_posix()] = entry(p)
    pinned = {"node": a.node, "python": Path(sys.executable), "protocol": a.protocol, "supervisor": Path(__file__),
              "selection": a.selection, "baseline": a.data_dir / BASELINE, "input": a.data_dir / INPUT, "rankings": a.data_dir / RANKINGS}
    for key, p in pinned.items(): m[key] = sha(Path(p).resolve())
    return m


def verify_manifest(a: argparse.Namespace, want: dict[str, str]) -> None:
    got = manifest(a)
    bad = sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))
    if bad: raise Failure("inventory_mismatch", 3, {"count": len(bad), "first": bad[:20]})


def stage_command(a: argparse.Namespace, arm: str, inp: Path, rank: Path, out: Path) -> list[str]:
    flags = {**COMMON, "--reasoning-effort": EFFORT[arm]}
    return ["dgx", "run", "--", str(a.node), "--import", "tsx", "benchmark/longmemeval-qa.ts",
            "--input", str(inp), "--retrieval", "cached", "--rankings", str(rank),
            *[x for kv in flags.items() for x in kv], "--out", str(out)]


def _physical(call: dict, name: str, parent: dict | None = None):
    """Yield (label, call, parent) for a call and every nested transport failure."""
    yield name, call, parent
    nested = call.get("transport_failures")
    for i, f in enumerate(nested if isinstance(nested, list) else []):
        if isinstance(f, dict): yield from _physical(f, f"{name}.transport_failures[{i}]", call)


def _config_problems(row: dict, arm: str) -> list[str]:
    """Recorded settings must match the declared arm, the recovery policy and the fixed check/judge settings."""
    out: list[str] = []

    def expect(label: str, call: Any, effort: str | None, tokens: int) -> None:
        want = {"reasoning_effort": effort, "max_output_tokens": tokens}
        if not isinstance(call, dict): return
        got = call.get("request_config")
        # The adaptive request marker is optional; when present it must be the arm's declared setting.
        if isinstance(got, dict) and got.get("requested_reasoning_effort") in (EFFORT[arm],) and label.endswith("answer_call"):
            got = {k: v for k, v in got.items() if k != "requested_reasoning_effort"}
        if got != want: out.append(f"{label} config {call.get('request_config')} want {want}")
    ac, fc, first = row.get("answer_call"), row.get("failed_answer_call"), INITIAL[arm]
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


def _row_problems(row: dict, arm: str) -> list[str]:
    out = []
    for key in ("answer_call", "premise_call", "judge_call"):
        c = row.get(key)
        if not isinstance(c, dict): out.append(f"{key} missing"); continue
        if c.get("error") is not None: out.append(f"{key}.error={c['error']}")
    ac = row.get("answer_call")
    if isinstance(ac, dict) and not (isinstance(ac.get("prompt_sha256"), str) and ac["prompt_sha256"]): out.append("answer prompt hash missing")
    if not isinstance(row.get("premise_recorded"), bool): out.append("premise_recorded not boolean")
    ev = row.get("evidence")
    if not (isinstance(ev, dict) and isinstance(ev.get("text"), str) and ev["text"]): out.append("evidence.text missing")
    failed = row.get("failed_answer_call")
    if isinstance(failed, dict) and isinstance(ac, dict) and failed.get("prompt_sha256") != ac.get("prompt_sha256"):
        out.append("recovered call prompt hash differs")
    return out + _config_problems(row, arm)


def check_rows(rows: list[dict], ids: list[str], abs_ids: set[str], arm: str) -> list[str]:
    got = [r.get("question_id") for r in rows]
    problems: list[str] = []
    if sorted(map(str, got)) != sorted(ids):
        problems.append(f"ids wrong: missing={sorted(set(ids) - set(got))} extra={sorted(set(map(str, got)) - set(ids))} count={len(got)}")
    for r in rows:
        q = r.get("question_id")
        if r.get("error"): problems.append(f"{q}: row error {r['error']}")
        if not isinstance(r.get("correct"), bool): problems.append(f"{q}: correct is not boolean")
        if q in ids and bool(r.get("is_abstention")) != (q in abs_ids): problems.append(f"{q}: abstention flag differs from frozen input")
        problems += [f"{q}: {p}" for p in _row_problems(r, arm)]
    return problems


def check_report(report: dict, ids: list[str], abs_ids: set[str], arm: str, expect: dict[str, str]) -> list[str]:
    problems = [] if report.get("status") == "complete" else [f"report status {report.get('status')}"]
    inv, s = report.get("invocation") or {}, report.get("summary") or {}
    for flag, key in INVOCATION.items():
        want = EFFORT[arm] if key == "reasoningEffort" else COMMON[flag]
        if str(inv.get(key)) != want: problems.append(f"invocation {key}={inv.get(key)} want {want}")
    for key, want in {**expect, "retrieval": "cached"}.items():
        if inv.get(key) != want: problems.append(f"invocation {key} differs")
    if s.get("errors") != 0 or s.get("planned") != len(ids) or s.get("recorded") != len(ids):
        problems.append(f"summary not clean: errors={s.get('errors')} planned={s.get('planned')} recorded={s.get('recorded')}")
    return problems + check_rows(report.get("results") or [], ids, abs_ids, arm)


def usage(rows: list[dict]) -> dict:
    u: dict[str, Any] = {"physical_calls": Counter(), "transport_failures": Counter(), "unknown_usage_calls": Counter(), "tokens": Counter(),
                         "elapsed_ms": Counter(), "attempts": Counter(), "answer_effort": Counter(),
                         "unknown_usage": [], "fallbacks": [], "failed_configs": []}
    for r in rows:
        for k in ("answer_call", "failed_answer_call", "premise_call", "judge_call"):
            if not isinstance(r.get(k), dict): continue
            for label, c, parent in _physical(r[k], k):
                u["physical_calls"][k] += 1
                u["transport_failures"][k] += int(parent is not None)
                u["elapsed_ms"][k] += c.get("elapsed_ms") or 0
                u["attempts"][k] += c.get("attempts") or 0
                us = c.get("usage")
                if not (isinstance(us, dict) and isinstance(us.get("input_tokens"), int) and isinstance(us.get("output_tokens"), int)):
                    u["unknown_usage_calls"][k] += 1  # failed or unmetered calls are reported, never counted as zero
                    u["unknown_usage"].append({"question_id": r["question_id"], "call": label, "error": c.get("error")})
                    continue
                for name, val in (("input", us["input_tokens"]), ("output", us["output_tokens"]),
                                  ("reasoning", (us.get("output_tokens_details") or {}).get("reasoning_tokens"))):
                    u["tokens"][f"{k}.{name}"] += val or 0
                    u["tokens"][f"total.{name}"] += val or 0
        final = ((r.get("answer_call") or {}).get("request_config") or {}).get("reasoning_effort")
        u["answer_effort"][str(final)] += 1
        f = r.get("failed_answer_call")
        if isinstance(f, dict):
            cfg = f.get("request_config") or {}
            u["failed_configs"].append({"question_id": r["question_id"], "config": cfg, "error": f.get("error")})
            u["fallbacks"].append({"question_id": r["question_id"], "failed_effort": cfg.get("reasoning_effort"), "final_effort": final, "recovered": bool(r.get("answer_recovered"))})
    return {k: dict(v) if isinstance(v, Counter) else v for k, v in u.items()}


def _get(rows: dict[str, dict], q: str, *path: str) -> Any:
    v: Any = rows.get(q)
    for p in path: v = v.get(p) if isinstance(v, dict) else None
    return v


def compare(ids: list[str], control: dict[str, dict], candidate: dict[str, dict], abs_ids: set[str], instructions: dict[str, set] | None = None) -> dict:
    ok = lambda rows, q: _get(rows, q, "correct") is True
    gains = [q for q in ids if not ok(control, q) and ok(candidate, q)]
    losses = [q for q in ids if ok(control, q) and not ok(candidate, q)]
    abs_losses = [q for q in losses if q in abs_ids]
    mismatch = [q for q in ids if _get(control, q, "evidence", "text") != _get(candidate, q, "evidence", "text")
                or _get(control, q, "answer_call", "prompt_sha256") != _get(candidate, q, "answer_call", "prompt_sha256")]
    c_ok, k_ok = sum(ok(control, q) for q in ids), sum(ok(candidate, q) for q in ids)
    complete = len(control) == len(candidate) == len(ids) and not check_rows(list(control.values()), ids, abs_ids, "control") and not check_rows(list(candidate.values()), ids, abs_ids, "candidate")
    same = bool(instructions) and all(len(instructions.get(arm) or ()) == 1 for arm in ("control", "candidate")) and instructions["control"] == instructions["candidate"]
    checks = {"all_rows_present_error_free": complete, "net_gain_at_least_2": k_ok - c_ok >= 2,
              "no_abstention_pair_loss": not abs_losses, "evidence_and_prompts_match": not mismatch, "answer_instructions_match": same}
    return {"advancement_screen_passed": all(checks.values()), "checks": checks, "control_correct": c_ok, "candidate_correct": k_ok,
            "net": k_ok - c_ok, "gains": gains, "losses": losses, "abstention_losses": abs_losses,
            "abstention_pairs": {q: {"control": ok(control, q), "candidate": ok(candidate, q)} for q in ids if q in abs_ids},
            "prompt_or_evidence_mismatch": mismatch}


def default_runner(cmd: list[str], cwd: Path, env: dict, stdout: Any, stderr: Any) -> int:
    return subprocess.run(cmd, cwd=cwd, env=env, stdout=stdout, stderr=stderr).returncode


def run_stage(a: argparse.Namespace, s: dict, st: dict, inv: dict, abs_ids: set[str], runner: Runner, save: Callable[[], None]) -> list[dict]:
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
    if not report.exists():
        rec["status"] = "no_report"
        raise Failure("stage_no_report", 5, {"stage": s["index"], "exit_code": code})
    rec["report_sha256"] = sha(report)
    for key, suffix in (("jsonl_sha256", ".jsonl"), ("progress_sha256", ".progress.json")):
        if Path(f"{report}{suffix}").exists(): rec[key] = sha(Path(f"{report}{suffix}"))
    rec["stdout_sha256"], rec["stderr_sha256"] = sha(d / "stdout.log"), sha(d / "stderr.log")
    try: rep = load(report)
    except ValueError:
        rec["status"] = "invalid_json"
        raise Failure("stage_report_unparseable", 6, {"stage": s["index"]})
    expect = {"input": str(bdir / "input.json"), "rankings": str(bdir / "rankings.json"), "out": str(report)}
    problems = (["nonzero exit %s" % code] if code else []) + check_report(rep, s["ids"], abs_ids, s["arm"], expect)
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
    if a.out_dir.is_relative_to(a.source_root): raise Failure("out_dir_inside_source_root", 2)
    sel, baseline = load(a.selection), load(a.data_dir / BASELINE)
    if sha(a.data_dir / BASELINE) != BASELINE_SHA or sel.get("baseline_sha256") != BASELINE_SHA or sel.get("seed") != SEED:
        raise Failure("baseline_or_selection_mismatch", 2)
    ids = derive_selection(baseline["results"])
    if sel.get("selected_question_ids") != ids: raise Failure("selection_not_reproduced", 2, {"derived": ids})
    in_sha, rank_sha = sha(a.data_dir / INPUT), sha(a.data_dir / RANKINGS)
    bound = baseline.get("hashes") or {}  # the baseline run recorded the exact input and rankings it consumed
    if in_sha != bound.get("input") or rank_sha != bound.get("rankings"):
        raise Failure("input_or_rankings_not_baseline_bound", 2, {"input": in_sha, "rankings": rank_sha, "baseline": {k: bound.get(k) for k in ("input", "rankings")}})
    inp, rank = load(a.data_dir / INPUT), load(a.data_dir / RANKINGS)
    wanted = set(ids)
    if not wanted <= {c["question_id"] for c in inp["cases"]} or not wanted <= {r["question_id"] for r in rank["results"]}:
        raise Failure("selected_ids_missing_from_inputs", 2)
    abs_ids = {c["question_id"] for c in inp["cases"] if c.get("is_abstention") and c["question_id"] in wanted}
    stages = schedule(ids)
    (out / "blocks").mkdir()
    for b in range(SIZE // BLOCK):
        block_ids, d = ids[b * BLOCK:(b + 1) * BLOCK], out / "blocks" / f"block-{b}"
        d.mkdir()
        write_json(d / "input.json", subset_input(inp, block_ids, in_sha), True)
        write_json(d / "rankings.json", subset_rankings(rank, block_ids, rank_sha), True)
    inv = manifest(a)  # taken after generation, so it includes the block files every stage consumes
    write_json(out / "inventory.json", inv, exclusive=True)
    for s in stages:
        d = out / "blocks" / f"block-{s['block']}"
        s["cmd"] = stage_command(a, s["arm"], d / "input.json", d / "rankings.json", out / "stages" / f"{s['index']:02d}-{s['arm']}" / "report.json")
    st.update(selected_question_ids=ids, abstention_ids=sorted(abs_ids), inventory_sha256=canon(inv), inventory_files=len(inv), python=sys.version,
              hashes={k: inv[k] for k in ("supervisor", "protocol", "selection", "baseline", "input", "rankings", "node", "python")},
              block_sha256={k: v for k, v in inv.items() if k.startswith("block:")},
              schedule=[{k: s[k] for k in ("index", "block", "arm")} for s in stages], stages={},
              claim="Exploratory 24-question paired pilot only; not a full500 score.")
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
        results = run_stage(a, s, st, inv, abs_ids, runner or default_runner, save)
        rows[s["arm"]].update({r["question_id"]: r for r in results})
    verify_manifest(a, inv)
    instr = {arm: {r.get("answer_instructions_sha256") for r in st["stages"].values() if r["arm"] == arm} for arm in rows}
    result = compare(ids, rows["control"], rows["candidate"], abs_ids, instr)
    result.update(usage={arm: usage(list(r.values())) for arm, r in rows.items()}, selected_question_ids=ids, claim=st["claim"],
                  answer_instructions_sha256=st.get("answer_instructions_sha256"),
                  status="pending_source_review" if result["advancement_screen_passed"] else "screen_not_passed",
                  stage_report_sha256={str(i): s["report_sha256"] for i, s in st["stages"].items()})
    write_json(out / "result.json", result, exclusive=True)
    st.update(status=result["status"], advancement_screen_passed=result["advancement_screen_passed"], result_sha256=sha(out / "result.json"), finished_at=now())
    save()
    return 0


def parse(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    for flag in ("source-root", "data-dir", "node", "selection", "out-dir"): p.add_argument("--" + flag, type=Path, required=True)
    p.add_argument("--protocol", type=Path, default=Path(__file__).resolve().parent / "LONGMEMEVAL-EFFORT-PILOT-PROTOCOL.md")
    p.add_argument("--live", action="store_true", default=False)
    a = p.parse_args(argv)
    for k in ("source_root", "data_dir", "node", "selection", "out_dir", "protocol"): setattr(a, k, getattr(a, k).absolute())
    return a


def main(argv: list[str] | None = None, runner: Runner | None = None) -> int:
    a = parse(argv)
    if a.out_dir.exists():
        print(f"output_exists: {a.out_dir}", file=sys.stderr)
        return 4
    a.out_dir.parent.mkdir(parents=True, exist_ok=True)
    a.out_dir.mkdir()
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
