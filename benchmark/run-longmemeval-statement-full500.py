#!/usr/bin/env python3
"""Fail-closed runner for the user-requested exploratory statement-evidence full500 (LONGMEMEVAL-STATEMENT-FULL500-PROTOCOL.md).

Candidate only: all 500 canonical prepared cases in input order, 167 sequential blocks of at most three, fresh answer, premise and
judge calls with the unchanged pilot statement settings. The pilot supervisor (run-longmemeval-additive-trial.py under
--source-root, the frozen runtime) is exec'd and its helpers are reused: block files, stage commands, per-stage report checks
(mode statements), manifest hashing and usage accounting. This file is pinned in the inventory beside the frozen runtime, inputs,
protocol, source-turns manifest and every block file; the inventory is verified before every stage and after the run.
Default mode only prepares (no model calls). `--live` runs the stages through `dgx run`; DGX_KEY_FILE is inherited.
--pilot-inventory (the original live pilot's inventory.json) is mandatory: every key except the run-specific ones must match exactly,
and its hash is pinned and re-verified. The dgx launcher is resolved once (live requires it), stage commands use its absolute path and its digest is
pinned and re-verified with the runner around every stage. Injected runner/efforts/pins (tests only) make comparison_valid false and forbid any score claim.
After every stage the physical-LF journal (report.json.jsonl) and report.json.progress.json must exist and agree with the report rows and summary.
No retries, rejudging or repair. A stage that is invalid or failed stops the run and leaves a partial record with no result.json.
The result is always pending independent review; no score, including the 474 and 476 numeric targets, is a quality clearance.
"""
from __future__ import annotations

import argparse, hashlib, json, os, shutil, sys, types
from pathlib import Path
from typing import Any, Callable

sys.dont_write_bytecode = True
RUNNER = Path(__file__).resolve()
PROTOCOL_NAME = "LONGMEMEVAL-STATEMENT-FULL500-PROTOCOL.md"
TRIAL = "benchmark/run-longmemeval-additive-trial.py"
PINS = {"baseline_sha": "9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0",
        "input_sha": "169e909e5e514a8376871fb3351c6597e90bfdf696f6d7206ec33d91dd9c02f4",
        "rankings_sha": "3202a46e13795ee463c2dee91c7831c03f71ed6ee7668c19f7092675d6b1234d",
        "turns_sha": "1a3f7baa93c76512f04f2ef0423d2cbf2f521ded59f6c18af86415b68876e1f5", "total": 500, "abstentions": 30}
RUN_SPECIFIC = ("protocol", "selection", "efforts", "runner", "pilot_inventory")
BLOCK, TARGET_PUBLISHED, TARGET_95, HISTORICAL = 3, 474, 476, 472
PARITY_KEYS = ("node", "python", "supervisor", "validation", "statement_validation", "source_turns", "baseline", "input", "rankings")
CLAIM = ("Exploratory user-requested full500 of the original statement-evidence candidate, fresh calls for all 500 questions; the public corpus "
         "has been repeatedly inspected, Hindsight uses different models, and the prior failed source-review gate is not cleared. "
         "Publication stays pending independent review.")


def load_trial(root: Path) -> types.ModuleType:
    """Exec the frozen pilot supervisor with its own __file__, so its validators and manifest paths resolve inside the frozen tree."""
    p = root / TRIAL
    m = types.ModuleType("statement_full500_frozen_trial")
    m.__dict__.update(__file__=str(p), __name__="statement_full500_frozen_trial")
    exec(compile(p.read_text(), str(p), "exec"), m.__dict__)
    return m


def is_native(runner: Any, efforts: Any, pins: Any) -> bool:
    """Only the command-line entry point (no injected runner, effort function or pins) can produce a comparable result."""
    return runner is None and efforts is None and pins is None


def parity_diff(base: dict, pilot: dict) -> list[str]:
    """Exact manifest parity with the frozen pilot: same key set and digests, apart from the run-specific entries and block files."""
    keys = {k for k in (*base, *pilot) if k not in RUN_SPECIFIC and not k.startswith("block:")}
    return sorted(k for k in keys if base.get(k) != pilot.get(k))


def claim_view(sc: dict, valid: bool) -> dict:
    if valid: return sc
    return {"denominator": sc["denominator"], "missing_rows": sc["missing_rows"], "error_rows": sc["error_rows"],
            "score_claim": "not_allowed: injected runner/efforts/pins make this comparison_valid false"}


def journal_problems(report: Path) -> list[str]:
    """The stage journal and progress file must exist and match the report: LF-delimited rows (split on b"\\n" only, never on
    Unicode line separators) with unique integer indices covering every report row, each equal to its report row apart from
    `index`, and a complete progress record whose summary equals the report summary."""
    try: rep = json.loads(report.read_bytes())
    except (OSError, ValueError) as e: return [f"report unreadable: {e!r}"]
    results = rep.get("results") if isinstance(rep, dict) else None
    if not isinstance(results, list): return ["report results missing"]
    out: list[str] = []
    try: raw = Path(f"{report}.jsonl").read_bytes()
    except OSError: raw = None
    if raw is None: out.append("journal (.jsonl) missing")
    else:
        if not raw.endswith(b"\n"): out.append("journal does not end with a physical LF")
        parts = raw.split(b"\n")
        if raw.endswith(b"\n"): parts.pop()
        seen: dict[int, dict] = {}
        for n, line in enumerate(parts):
            try: row = json.loads(line)
            except ValueError: out.append(f"journal line {n} is not JSON"); continue
            if not isinstance(row, dict) or type(row.get("index")) is not int: out.append(f"journal line {n} lacks an integer index"); continue
            if row["index"] in seen: out.append(f"journal repeats index {row['index']}"); continue
            seen[row["index"]] = row
        if sorted(seen) != list(range(len(results))): out.append(f"journal indices are not exactly 0..{len(results) - 1} (found {len(seen)})")
        out += [f"journal row {i} differs from the report row" for i, r in sorted(seen.items())
                if 0 <= i < len(results) and {k: v for k, v in r.items() if k != "index"} != results[i]]
    try: prog = json.loads(Path(f"{report}.progress.json").read_bytes())
    except OSError: out.append("progress (.progress.json) missing")
    except ValueError: out.append("progress is not JSON")
    else:
        if not isinstance(prog, dict) or prog.get("status") != "complete": out.append("progress status is not complete")
        elif prog.get("summary") != rep.get("summary"): out.append("progress summary differs from the report summary")
        el = prog.get("elapsed_s") if isinstance(prog, dict) else None
        if isinstance(prog, dict) and not (isinstance(el, (int, float)) and not isinstance(el, bool) and el >= 0): out.append("progress elapsed_s invalid")
    return out[:20]


def score(ids: list[str], abs_ids: set[str], rows: dict[str, dict], base: dict[str, Any]) -> dict:
    """Raw judged score over the fixed denominator; missing, errored and non-boolean rows count incorrect."""
    ok = lambda q: isinstance(rows.get(q), dict) and rows[q].get("correct") is True and not rows[q].get("error")
    n, a_ok = sum(ok(q) for q in ids), sum(ok(q) for q in ids if q in abs_ids)
    types_: dict[str, list[int]] = {}
    for q in ids:
        t = str((rows.get(q) or {}).get("question_type"))
        types_.setdefault(t, [0, 0])[1] += 1
        types_[t][0] += ok(q)
    gains = [q for q in ids if ok(q) and base.get(q) is False]
    losses = [q for q in ids if not ok(q) and base.get(q) is True]
    return {"denominator": len(ids), "correct": n, "accuracy": round(n / len(ids), 4),
            "abstention": {"correct": a_ok, "total": len(abs_ids)}, "answerable": {"correct": n - a_ok, "total": len(ids) - len(abs_ids)},
            "by_question_type": {t: {"correct": c, "total": k} for t, (c, k) in sorted(types_.items())},
            "missing_rows": sum(q not in rows for q in ids), "error_rows": sum(bool((rows.get(q) or {}).get("error")) for q in ids),
            "incorrect_ids": [q for q in ids if not ok(q)],
            "targets": {"published_474": {"threshold": TARGET_PUBLISHED, "met": n >= TARGET_PUBLISHED},
                        "above_95_percent_476": {"threshold": TARGET_95, "met": n >= TARGET_95},
                        "note": "numeric only; not a quality, grounding or ranking clearance"},
            "historical_472_baseline": {"correct": HISTORICAL, "gains": gains, "losses": losses, "net": len(gains) - len(losses),
                                        "limits": "noncontemporaneous run; different treatment; not a matched comparison"}}


def execute(a: argparse.Namespace, M: types.ModuleType, st: dict, save: Callable[[], None], runner: Any, efforts: Any, pins: dict) -> int:
    F, out, sha, load, wj = M.Failure, a.out_dir, M.sha, M.load, M.write_json
    if sha(a.data_dir / M.BASELINE) != pins["baseline_sha"]: raise F("baseline_mismatch", 2)
    baseline = load(a.data_dir / M.BASELINE)
    in_sha, rank_sha = sha(a.data_dir / M.INPUT), sha(a.data_dir / M.RANKINGS)
    bound = baseline.get("hashes") or {}
    if (in_sha, rank_sha) != (bound.get("input"), bound.get("rankings")) or (in_sha, rank_sha) != (pins["input_sha"], pins["rankings_sha"]):
        raise F("input_or_rankings_not_pinned", 2, {"input": in_sha, "rankings": rank_sha})
    inp, rank = load(a.data_dir / M.INPUT), load(a.data_dir / M.RANKINGS)
    cases = inp["cases"]
    ids = [c["question_id"] for c in cases]
    if len(set(ids)) != len(ids): raise F("duplicate_input_ids", 2)
    if len(ids) != pins["total"]: raise F("cohort_size_mismatch", 2, len(ids))
    if any(not isinstance(c.get("is_abstention"), bool) for c in cases): raise F("abstention_flag_not_boolean", 2)
    abs_ids = {c["question_id"] for c in cases if c["is_abstention"]}
    if len(abs_ids) != pins["abstentions"]: raise F("abstention_count_mismatch", 2, len(abs_ids))
    lacking = set(ids) - {r["question_id"] for r in rank["results"]}
    if lacking: raise F("rankings_missing_ids", 2, sorted(lacking)[:5])
    turns_sha = sha(a.source_turns)
    if turns_sha != pins["turns_sha"]: raise F("source_turns_not_pinned", 2, turns_sha)
    raw_sha = (inp.get("provenance") or {}).get("dataset_sha256")
    try: tm = load(a.source_turns)
    except (OSError, ValueError) as e: raise F("source_turns_unreadable", 2, repr(e))
    if bad := M.statement_validation().turns_manifest_problems(tm, ids, in_sha, raw_sha): raise F("source_turns_invalid", 2, bad[:10])
    del tm
    found = shutil.which("dgx")  # resolved once; every stage command uses this absolute path and its file digest is pinned
    dgx = Path(found).absolute() if found and Path(found).is_file() else None
    if a.live:  # before any artifact beyond state.json
        if not os.environ.get("DGX_KEY_FILE"): raise F("dgx_key_file_unset", 7)
        if dgx is None: raise F("dgx_unavailable", 7)
    turns = {"path": str(a.source_turns), "sha256": turns_sha, "input_sha256": in_sha, "raw_dataset_sha256": raw_sha}
    wj(out / "selection.json", {"rule": "all canonical prepared cases in original input order; no correctness, reference or marked-source input",
                               "count": len(ids), "abstention_count": len(abs_ids), "answerable_count": len(ids) - len(abs_ids),
                               "selected_question_ids": ids, "abstention_ids": [q for q in ids if q in abs_ids], "input_sha256": in_sha,
                               "rankings_sha256": rank_sha, "baseline_sha256": pins["baseline_sha"], "source_turns": turns, "recorded_at": M.now()}, True)
    init = (efforts or M.derive_efforts)(a, cases, ids)
    wj(out / "efforts.json", {"policy": M.POLICY_TS, "policy_sha256": sha(a.source_root / M.POLICY_TS), "initial_effort": init}, True)
    groups = [ids[i:i + BLOCK] for i in range(0, len(ids), BLOCK)]
    (out / "blocks").mkdir()
    for b, g in enumerate(groups):
        d = out / "blocks" / f"block-{b}"
        d.mkdir()
        wj(d / "input.json", M.subset_input(inp, g, in_sha), True)
        wj(d / "rankings.json", M.subset_rankings(rank, g, rank_sha), True)
    base_inv = M.manifest(a)  # after block generation, so every block file is pinned
    try:
        pb = a.pilot_inventory.read_bytes()
        pilot = json.loads(pb)
    except (OSError, ValueError) as e: raise F("pilot_inventory_unreadable", 2, repr(e))
    if not isinstance(pilot, dict) or not pilot: raise F("pilot_inventory_invalid", 2)
    if diff := parity_diff(base_inv, pilot): raise F("pilot_runtime_mismatch", 2, {"count": len(diff), "first": diff[:20]})
    inv = {**base_inv, "runner": sha(RUNNER), "pilot_inventory": hashlib.sha256(pb).hexdigest(),
           **({"dgx": sha(dgx)} if dgx else {})}  # pinned only after the parity check
    wj(out / "inventory.json", inv, True)
    stages = [{"index": b, "block": b, "arm": "candidate", "ids": g,
               "cmd": M.stage_command(a, "candidate", out / "blocks" / f"block-{b}" / "input.json", out / "blocks" / f"block-{b}" / "rankings.json",
                                      out / "stages" / f"{b:02d}-candidate" / "report.json", "statements")} for b, g in enumerate(groups)]
    for s_ in stages:
        if dgx: s_["cmd"] = [str(dgx), *s_["cmd"][1:]]  # new list only; the frozen stage_command is untouched
    st.update(selected_question_ids=ids, abstention_ids=sorted(abs_ids), initial_effort=init, inventory_sha256=M.canon(inv), inventory_files=len(inv),
              python=sys.version, hashes={k: inv[k] for k in (*PARITY_KEYS, *RUN_SPECIFIC, *(("dgx",) if dgx else ()))}, source_turns=turns,
              dgx={"path": str(dgx), "sha256": inv["dgx"]} if dgx else None,
              block_sha256={k: v for k, v in inv.items() if k.startswith("block:")}, schedule=[{k: s[k] for k in ("index", "block", "arm")} for s in stages],
              stages={}, cohort_size=len(ids), claim=CLAIM)
    if not a.live:
        st.update(status="prepared", finished_at=M.now(), planned_commands=[s["cmd"] for s in stages])
        save()
        return 0
    st["status"] = "running"
    (out / "stages").mkdir()

    def check_extras() -> None:
        bad = [k for k, p in (("runner", RUNNER), ("pilot_inventory", a.pilot_inventory), *((("dgx", dgx),) if dgx else ())) if sha(p) != inv[k]]
        if bad: raise F("inventory_mismatch", 3, {"count": len(bad), "first": bad})

    rows: dict[str, dict] = {}
    try:
        for s in stages:
            check_extras()
            res = M.run_stage(a, s, st, base_inv, abs_ids, init, runner or M.default_runner, save, turns)
            if bad := journal_problems(out / "stages" / f"{s['index']:02d}-candidate" / "report.json"):
                st["stages"][s["index"]].update(status="journal_invalid", problems=bad)
                raise F("stage_journal_invalid", 6, {"stage": s["index"], "problems": bad[:10]})
            rows.update({r["question_id"]: r for r in res})
            st["progress"] = {"denominator": len(ids), "scored_rows": len(rows), "correct_among_scored": sum(r.get("correct") is True for r in rows.values()),
                              "remaining": len(ids) - len(rows), "valid_stages": s["index"] + 1, "total_stages": len(stages)}  # status polling only; no calls
            save()
            check_extras()
        M.verify_manifest(a, base_inv)
        check_extras()
    except BaseException:
        okc = sum(r.get("correct") is True for r in rows.values())
        st["partial"] = {"denominator": len(ids), "valid_stages": sum(v.get("status") == "valid" for v in st["stages"].values()), "scored_rows": len(rows),
                         "correct_among_scored": okc, "unscored_counted_incorrect": len(ids) - len(rows), "claimable": False,
                         "note": "incomplete run; no result.json; not a score"}
        raise
    if set(rows) != set(ids): raise F("incomplete_rows", 6, {"rows": len(rows)})
    calls = {k: sum(isinstance(r.get(f"{k}_call"), dict) and bool(r[f"{k}_call"].get("prompt_sha256")) for r in rows.values()) for k in ("answer", "premise", "judge")}
    base = {r.get("question_id"): r.get("correct") for r in baseline.get("results", []) if isinstance(r, dict)} if isinstance(baseline.get("results"), list) else {}
    valid = st["comparison_valid"]
    result = {"status": "pending_independent_review" if valid else "comparison_invalid", "comparison_valid": valid, "claim": CLAIM,
              "score": claim_view(score(ids, abs_ids, rows, base), valid),
              "publication": {"status": "pending", "automatic_publication": False, "independent_review_required": True, "quality_clearance": "not_assessed"},
              "fresh_calls": {**calls, "expected_per_kind": len(ids), "expected_total": 3 * len(ids), "reused_prior_answers": False},
              "errors": sum(bool(r.get("error")) for r in rows.values()), "usage": M.usage(list(rows.values())), "selected_question_ids": ids,
              "answer_instructions_sha256": st.get("answer_instructions_sha256"), "source_turns": turns, "inventory_sha256": st["inventory_sha256"],
              "stage_report_sha256": {str(i): v["report_sha256"] for i, v in st["stages"].items()}}
    wj(out / "result.json", result, True)
    st.update(status=result["status"], result_sha256=sha(out / "result.json"), correct=result["score"].get("correct"), finished_at=M.now())
    save()
    return 0


def parse(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    for f in ("source-root", "data-dir", "node", "out-dir", "protocol", "source-turns"): p.add_argument("--" + f, type=Path, required=True)
    p.add_argument("--pilot-inventory", type=Path, required=True, help="the original live pilot's inventory.json; all non-run-specific keys must match exactly")
    p.add_argument("--live", action="store_true", default=False)
    a = p.parse_args(argv)
    if a.protocol.name != PROTOCOL_NAME: p.error(f"--protocol must be {PROTOCOL_NAME}")
    for k in ("source_root", "data_dir", "node", "out_dir", "protocol", "source_turns", "pilot_inventory"):
        if getattr(a, k) is not None: setattr(a, k, getattr(a, k).absolute())
    for k in ("protocol", "source_turns", "pilot_inventory"):
        if getattr(a, k) is not None and not getattr(a, k).is_file(): p.error(f"--{k.replace('_', '-')} file not found: {getattr(a, k)}")
    if not (a.source_root / TRIAL).is_file(): p.error(f"frozen supervisor not found under --source-root: {TRIAL}")
    a.candidate_evidence = "statements"
    return a


def main(argv: list[str] | None = None, runner: Any = None, efforts: Any = None, pins: dict | None = None) -> int:
    a = parse(argv)
    try: M = load_trial(a.source_root)
    except Exception as e:
        print(f"frozen_supervisor_unloadable: {e!r}", file=sys.stderr)
        return 2
    if a.out_dir.resolve().is_relative_to(a.source_root.resolve()):
        print(f"out_dir_inside_source_root: {a.out_dir}", file=sys.stderr)
        return 2
    a.out_dir.parent.mkdir(parents=True, exist_ok=True)
    try: a.out_dir.mkdir()
    except FileExistsError:
        print(f"output_exists: {a.out_dir}", file=sys.stderr)
        return 4
    st: dict[str, Any] = {"started_at": M.now(), "status": "preparing", "mode": "live" if a.live else "prepare", "candidate_evidence": "statements",
                          "source_root": str(a.source_root), "out_dir": str(a.out_dir), "runner": str(RUNNER),
                          "comparison_valid": is_native(runner, efforts, pins)}
    save = lambda: M.write_json(a.out_dir / "state.json", st)
    save()
    try: return execute(a, M, st, save, runner, efforts, pins or PINS)
    except M.Failure as e:
        st.update(status=e.status, detail=e.detail, finished_at=M.now())
        save()
        print(f"{e.status}: {e.detail}", file=sys.stderr)
        return e.code
    except Exception as e:  # fail closed on any unexpected error
        st.update(status="error", detail=repr(e), finished_at=M.now())
        save()
        print(f"error: {e!r}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
