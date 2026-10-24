"""Offline tests for run-longmemeval-statement-full500.py (fake runner, no model calls).

The runner exec's the real pilot supervisor and reuses its validators, so these tests exercise the actual helpers on a tiny
frozen tree with 500 synthetic cases (30 unanswerable). One class feeds a block of real output (actual source-turns builder
and actual TS QA run with a stub model) through the same block files and validators.
"""
import importlib.util, io, json, os, shutil, subprocess, sys, tempfile, types, unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).parent
ROOT = HERE.parent


def loadmod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


T = loadmod("statement_trial_tests_for_full500", HERE / "test_run_longmemeval_statement_trial.py")
R = loadmod("statement_full500_runner", HERE / "run-longmemeval-statement-full500.py")
S = T.S
N = 500


def fake_efforts(a, cases, ids): return {q: S.effort_of(q) for q in ids}


def with_journal(run, calls, mut=None):
    """Wrap a fake stage runner so it also leaves the .jsonl journal (physical LF rows, raw Unicode) and .progress.json the real QA writes."""
    def go(cmd, cwd, env, so, se):
        code = run(cmd, cwd, env, so, se)
        out = Path(dict(zip(cmd[7::2], cmd[8::2]))["--out"])
        if out.exists():
            rep = json.loads(out.read_text())
            j, p = Path(f"{out}.jsonl"), Path(f"{out}.progress.json")
            j.write_bytes(b"".join((json.dumps({"index": i, **r}, ensure_ascii=False) + "\n").encode() for i, r in enumerate(rep["results"])))
            p.write_bytes(json.dumps({"status": "complete", "elapsed_s": 1, "summary": rep["summary"]}).encode())
            if mut: mut(len(calls), j, p)
        return code
    return go


def edit_lines(j, f):
    rows = [json.loads(x) for x in j.read_bytes().split(b"\n")[:-1]]
    f(rows)
    j.write_bytes(b"".join((json.dumps(r, ensure_ascii=False) + "\n").encode() for r in rows))


class Env500:
    """Tiny frozen source tree plus a 500-case input, rankings, baseline and source-turns manifest, all hash-consistent."""
    def __init__(self, tmp: Path, dup=False, drop_rank=False, drop_turn=False, n=N):
        self.tmp, self.root = tmp, tmp / "root"
        for d in ("src", "benchmark", "drizzle", "node_modules"): (self.root / d).mkdir(parents=True)
        (self.root / "src/a.ts").write_text("a")
        (self.root / "benchmark/longmemeval-inference-policy.ts").write_text("policy")
        for f in ("run-longmemeval-additive-trial.py", "longmemeval_additive_validation.py", "longmemeval_statement_validation.py"):
            shutil.copy(HERE / f, self.root / "benchmark" / f)
        for f in ("package.json", "package-lock.json", "tsconfig.json"): (self.root / f).write_text("{}")
        self.node, self.protocol, self.data, self.turns = tmp / "node", tmp / R.PROTOCOL_NAME, tmp / "data", tmp / "turns.json"
        self.node.write_text("node")
        self.dgx = tmp / "tools" / "dgx"  # fixture launcher outside the frozen root; shutil.which is patched to find it
        self.dgx.parent.mkdir()
        self.dgx.write_text("dgx launcher")
        self.protocol.write_text("protocol")
        self.data.mkdir()
        M = self.M = R.load_trial(self.root)
        self.ids = [f"q{i:03d}" for i in range(n)]
        self.abs = {self.ids[i * 16 + 3] for i in range(30)}
        cases = [{"question_id": q, "is_abstention": q in self.abs, "question": "Q" + q} for q in self.ids]
        if dup: cases[-1]["question_id"] = cases[0]["question_id"]
        (self.data / M.INPUT).write_text(json.dumps({"provenance": {"dataset_sha256": "d"}, "cases": cases}))
        ranked = self.ids[1:] if drop_rank else self.ids
        (self.data / M.RANKINGS).write_text(json.dumps({"status": "complete", "results": [{"question_id": q} for q in ranked]}))
        in_sha, rank_sha = M.sha(self.data / M.INPUT), M.sha(self.data / M.RANKINGS)
        self.base = {q: i % 20 != 0 for i, q in enumerate(self.ids)}
        (self.data / M.BASELINE).write_text(json.dumps({"hashes": {"input": in_sha, "rankings": rank_sha},
                                                         "results": [{"question_id": q, "correct": v} for q, v in self.base.items()]}))
        self.write_turns(in_sha, drop=drop_turn)
        self.pins = {"baseline_sha": M.sha(self.data / M.BASELINE), "input_sha": in_sha, "rankings_sha": rank_sha,
                     "turns_sha": M.sha(self.turns), "total": len(cases), "abstentions": 30}
        self.out = tmp / "out"
        self.pilotfile = tmp / "pilot-inventory.json"
        self.pilotfile.write_text(json.dumps(self.pilot_inv()))

    def pilot_inv(self):
        """The inventory the original pilot would have recorded for this frozen tree (same builder, run-specific entries aside)."""
        d = self.tmp / "pilot-dir"
        d.mkdir(exist_ok=True)
        for f in ("selection.json", "efforts.json"): (d / f).write_text("{}")
        ns = types.SimpleNamespace(source_root=self.root, out_dir=d, node=self.node, protocol=self.protocol, data_dir=self.data,
                                   candidate_evidence="statements", source_turns=self.turns)
        return self.M.manifest(ns)

    def write_turns(self, in_sha, drop=False):
        ids = self.ids[1:] if drop else self.ids
        self.turns.write_text(json.dumps({"kind": "longmemeval-source-turns-v1", "input_sha256": in_sha, "raw_dataset_sha256": "d",
                                          "cases": [{"question_id": q, "sessions": [1]} for q in ids]}))

    def run(self, name="out", live=False, runner=None, key=True, pins=None, protocol=None, pilot=None, rmod=None, out=None, which=True):
        argv = ["--source-root", str(self.root), "--data-dir", str(self.data), "--node", str(self.node), "--out-dir", str(out or self.tmp / name),
                "--protocol", str(protocol or self.protocol), "--source-turns", str(self.turns)]
        argv += (["--live"] if live else []) + (["--pilot-inventory", str(self.pilotfile if pilot is None else pilot)] if pilot != "omit" else [])
        with redirect_stderr(io.StringIO()), mock.patch.dict(os.environ, {"DGX_KEY_FILE": "/unused"} if key else {}), \
                mock.patch("shutil.which", return_value=str(self.dgx) if which else None):
            if not key: os.environ.pop("DGX_KEY_FILE", None)
            return (rmod or R).main(argv, runner, fake_efforts, {**self.pins, **(pins or {})})

    def state(self, name="out"): return json.loads((self.tmp / name / "state.json").read_text())
    def result(self, name="out"): return json.loads((self.tmp / name / "result.json").read_text())


class Base(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(dir="/tmp", prefix="recall-full500-test-")
        self.addCleanup(self.td.cleanup)
        self.tmp = Path(self.td.name)
        self.env = Env500(self.tmp)

    def fake(self, calls, wrong=(), jmut=None, **kw):
        wrong = set(wrong)
        return with_journal(T.sfake(calls, lambda arm, q: q not in wrong, **kw), calls, jmut)


class Prepare(Base):
    def test_cli_guards(self):
        wrong = self.tmp / "OTHER.md"
        wrong.write_text("x")
        with self.assertRaises(SystemExit): self.env.run(protocol=wrong)
        with self.assertRaises(SystemExit): self.env.run(pilot=self.tmp / "absent.json")
        with self.assertRaises(SystemExit): self.env.run(pilot="omit")  # the pilot inventory is mandatory, prepare included
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            R.main(["--source-root", str(self.env.root), "--data-dir", str(self.env.data), "--node", "n", "--out-dir", str(self.tmp / "x"), "--protocol", str(self.env.protocol)])
        self.assertFalse((self.tmp / "out").exists())

    def test_prepare_plans_167_candidate_only_blocks_over_all_500_in_input_order(self):
        calls = []
        self.assertEqual(self.env.run(runner=self.fake(calls)), 0)
        self.assertEqual(calls, [])  # preparation makes no calls
        st = self.env.state()
        self.assertEqual((st["status"], st["mode"], st["candidate_evidence"], st["cohort_size"]), ("prepared", "prepare", "statements", 500))
        self.assertEqual(st["selected_question_ids"], self.env.ids)  # input order, not outcome or hash order
        self.assertIs(st["comparison_valid"], False)  # the test overrides (runner/efforts/pins) are injected
        dgx_sha = self.env.M.sha(self.env.dgx)
        self.assertEqual(st["dgx"], {"path": str(self.env.dgx), "sha256": dgx_sha})
        self.assertEqual(st["hashes"]["dgx"], dgx_sha)
        self.assertEqual(json.loads((self.env.out / "inventory.json").read_text())["dgx"], dgx_sha)
        self.assertTrue(all(c[0] == str(self.env.dgx) for c in st["planned_commands"]))  # absolute launcher, never a PATH lookup
        self.assertEqual(self.env.run("nodgx_prep", which=False), 0)  # preparation may proceed without a launcher
        nd = self.env.state("nodgx_prep")
        self.assertEqual((nd["dgx"], "dgx" in nd["hashes"], nd["planned_commands"][0][0]), (None, False, "dgx"))
        self.assertNotIn("dgx", json.loads((self.tmp / "nodgx_prep/inventory.json").read_text()))
        cmds = st["planned_commands"]
        self.assertEqual(len(cmds), 167)
        for i, c in enumerate(cmds):
            flags = dict(zip(c[7::2], c[8::2]))
            self.assertEqual((flags["--evidence"], flags["--source-turns"], flags["--reasoning-effort"], flags["--max-output-tokens"], flags["--concurrency"]),
                             ("statements", str(self.env.turns), "adaptive", "16384", "3"))
            self.assertEqual(flags["--answer-check"], "premise")
            self.assertIn(f"/blocks/block-{i}/input.json", flags["--input"])
        sizes = [len(json.loads((self.env.out / f"blocks/block-{b}/input.json").read_text())["cases"]) for b in (0, 1, 165, 166)]
        self.assertEqual(sizes, [3, 3, 3, 2])
        sel = json.loads((self.env.out / "selection.json").read_text())
        self.assertEqual((sel["abstention_count"], sel["answerable_count"], sel["selected_question_ids"]), (30, 470, self.env.ids))
        inv = json.loads((self.env.out / "inventory.json").read_text())
        for k in ("runner", "pilot_inventory", "protocol", "source_turns", "statement_validation", "validation", "supervisor", "node", "python", "baseline", "input", "rankings"):
            self.assertIn(k, inv)
        self.assertEqual(inv["runner"], R.M_sha(R.RUNNER) if hasattr(R, "M_sha") else self.env.M.sha(R.RUNNER))
        self.assertEqual(inv["source_turns"], self.env.pins["turns_sha"])
        self.assertEqual(len([k for k in inv if k.startswith("block:")]), 334)
        self.assertFalse(any("control" in " ".join(c) or "supplemental" in " ".join(c) for c in cmds))
        self.assertEqual(self.env.run(), 4)  # a second run never reuses the output directory

    def test_cohort_and_pin_failures_stop_before_selection(self):
        cases = {"dup": (dict(dup=True), {}, "duplicate_input_ids"), "size": ({}, {"total": 499}, "cohort_size_mismatch"),
                 "abs": ({}, {"abstentions": 29}, "abstention_count_mismatch"), "base": ({}, {"baseline_sha": "0" * 64}, "baseline_mismatch"),
                 "input": ({}, {"input_sha": "1" * 64}, "input_or_rankings_not_pinned"), "turnspin": ({}, {"turns_sha": "2" * 64}, "source_turns_not_pinned"),
                 "rank": (dict(drop_rank=True), {}, "rankings_missing_ids"), "turn": (dict(drop_turn=True), {}, "source_turns_invalid")}
        for name, (kw, pins, status) in cases.items():
            env = Env500(self.tmp / name, **kw) if (self.tmp / name).mkdir() is None else None
            if "drop_rank" in kw or "dup" in kw: env.pins = {**env.pins}
            self.assertEqual(env.run(pins=pins), 2, name)
            self.assertEqual(env.state()["status"], status, name)
            self.assertFalse((env.tmp / "out/selection.json").exists(), name)

    def test_output_must_be_new_and_outside_the_frozen_root(self):
        self.assertEqual(self.env.run(out=self.env.root / "out"), 2)
        self.assertFalse((self.env.root / "out").exists())
        (self.tmp / "taken").mkdir()
        self.assertEqual(self.env.run("taken"), 4)

    def test_pilot_inventory_parity_is_exact_and_pinned(self):
        good = json.loads(self.env.pilotfile.read_text())
        self.assertEqual(self.env.run("a"), 0)
        inv = json.loads((self.tmp / "a/inventory.json").read_text())
        self.assertEqual(inv["pilot_inventory"], self.env.M.sha(self.env.pilotfile))
        self.assertEqual(self.env.state("a")["hashes"]["pilot_inventory"], inv["pilot_inventory"])
        def variant(i, data):
            f = self.tmp / f"pilot{i}.json"
            f.write_text(data if isinstance(data, str) else json.dumps(data))
            return f
        bad = [{**good, k: "0" * 64} for k in ("node", "python", "src:src/a.ts", "statement_validation", "validation", "supervisor", "source_turns", "baseline", "input", "rankings")]
        bad += [{k: v for k, v in good.items() if k != "node"}, {**good, "src:src/extra.ts": "0" * 64}, {k: v for k, v in good.items() if k != "src:src/a.ts"}]
        for i, data in enumerate(bad):
            self.assertEqual(self.env.run(f"c{i}", pilot=variant(i, data)), 2, i)
            self.assertEqual(self.env.state(f"c{i}")["status"], "pilot_runtime_mismatch", i)
            self.assertFalse((self.tmp / f"c{i}/inventory.json").exists())
        self.assertEqual(self.env.run("free", pilot=variant("f", {**good, "protocol": "x", "selection": "x", "efforts": "x", "block:b/input.json": "x"})), 0)
        for name, data, status in (("junk", "{not json", "pilot_inventory_unreadable"), ("list", "[]", "pilot_inventory_invalid"), ("empty", "{}", "pilot_inventory_invalid")):
            self.assertEqual(self.env.run(name, pilot=variant(name, data)), 2, name)
            self.assertEqual(self.env.state(name)["status"], status, name)


class Live(Base):
    def test_live_requires_key_and_dgx_before_any_artifact(self):
        calls = []
        self.assertEqual(self.env.run(live=True, key=False, runner=self.fake(calls)), 7)
        self.assertEqual((self.env.state()["status"], calls, (self.env.out / "selection.json").exists(), (self.env.out / "stages").exists()), ("dgx_key_file_unset", [], False, False))
        self.assertEqual(self.env.run("nodgx", live=True, which=False), 7)
        self.assertEqual(self.env.state("nodgx")["status"], "dgx_unavailable")
        self.assertFalse((self.tmp / "nodgx/selection.json").exists())
        self.env.dgx.unlink()  # a path that resolves but is not a file also counts as unavailable
        self.assertEqual(self.env.run("gone", live=True), 7)
        self.assertEqual(self.env.state("gone")["status"], "dgx_unavailable")

    def test_complete_run_counts_all_500_and_leaves_publication_pending(self):
        wrong, calls = self.env.ids[:26], []
        self.assertEqual(self.env.run(live=True, runner=self.fake(calls, wrong)), 0)
        self.assertEqual(len(calls), 167)
        for c in calls:
            flags = dict(zip(c[7::2], c[8::2]))
            self.assertEqual((c[0], flags["--evidence"], flags["--source-turns"]), (str(self.env.dgx), "statements", str(self.env.turns)))
        r, st = self.env.result(), self.env.state()
        sc = r["score"]
        self.assertEqual((r["status"], st["status"], r["comparison_valid"], st["comparison_valid"]), ("comparison_invalid", "comparison_invalid", False, False))
        self.assertEqual((sc["denominator"], sc["missing_rows"], sc["error_rows"], st["correct"]), (500, 0, 0, None))
        for k in ("correct", "accuracy", "targets", "historical_472_baseline", "incorrect_ids"): self.assertNotIn(k, sc)  # no score claim with injected overrides
        self.assertIn("not_allowed", sc["score_claim"])
        self.assertEqual((r["publication"]["status"], r["publication"]["automatic_publication"], r["publication"]["quality_clearance"]), ("pending", False, "not_assessed"))
        self.assertEqual(r["fresh_calls"], {"answer": 500, "premise": 500, "judge": 500, "expected_per_kind": 500, "expected_total": 1500, "reused_prior_answers": False})
        self.assertEqual((r["errors"], len(r["stage_report_sha256"]), r["usage"]["physical_calls"]["answer_call"]), (0, 167, 500))
        self.assertEqual(r["inventory_sha256"], st["inventory_sha256"])
        self.assertNotIn("partial", st)
        self.assertFalse(any("win" in k for k in (*r, *sc)))

    def test_only_the_native_entry_point_is_comparable(self):
        self.assertTrue(R.is_native(None, None, None))
        for args in ((lambda *a: 0, None, None), (None, fake_efforts, None), (None, None, {}), (None, None, dict(self.env.pins))): self.assertFalse(R.is_native(*args))
        ids = self.env.ids
        sc = R.score(ids, self.env.abs, {q: {"correct": True} for q in ids}, self.env.base)
        self.assertIs(R.claim_view(sc, True), sc)
        v = R.claim_view(sc, False)
        self.assertEqual(set(v), {"denominator", "missing_rows", "error_rows", "score_claim"})

    def test_score_thresholds_and_denominator(self):
        ids, abs_ids = self.env.ids, self.env.abs
        def rows(n): return {q: {"correct": i < n, "question_type": "t"} for i, q in enumerate(ids)}
        met = lambda n: tuple(R.score(ids, abs_ids, rows(n), self.env.base)["targets"][k]["met"] for k in ("published_474", "above_95_percent_476"))
        self.assertEqual((met(473), met(474), met(475), met(476)), ((False, False), (True, False), (True, False), (True, True)))
        bad = rows(500)
        bad[ids[0]]["error"] = "boom"
        bad[ids[1]]["correct"] = "true"  # not boolean
        del bad[ids[2]]
        sc = R.score(ids, abs_ids, bad, self.env.base)
        self.assertEqual((sc["denominator"], sc["correct"], sc["missing_rows"], sc["error_rows"]), (500, 497, 1, 1))

    def test_invalid_stage_stops_the_run_and_records_a_partial_without_a_score(self):
        calls = []
        tweak = lambda n, rows, arm: rows[0]["premise_call"].update(error="timeout") if n == 4 else None
        self.assertEqual(self.env.run(live=True, runner=self.fake(calls, tweak=tweak)), 6)
        st = self.env.state()
        self.assertEqual((len(calls), st["status"], (self.env.out / "result.json").exists()), (4, "stage_invalid", False))
        self.assertEqual(st["partial"], {"denominator": 500, "valid_stages": 3, "scored_rows": 9, "correct_among_scored": 9, "unscored_counted_incorrect": 491,
                                         "claimable": False, "note": "incomplete run; no result.json; not a score"})

    def test_runner_exit_without_report_stops(self):
        self.assertEqual(self.env.run(live=True, runner=lambda cmd, cwd, env, so, se: 1), 5)
        self.assertEqual((self.env.state()["status"], self.env.state()["partial"]["claimable"]), ("stage_no_report", False))

    def test_report_drift_is_rejected(self):
        edits = {"instructions": lambda n, rep: rep["answer_instructions"].update(sha256="other") if n == 3 else None,
                 "no_turns": lambda n, rep: rep.pop("source_turns_manifest") if n == 2 else None,
                 "turns_sha": lambda n, rep: rep["source_turns_manifest"].update(sha256="0" * 64) if n == 2 else None,
                 "control_evidence": lambda n, rep: rep["invocation"].update(evidence="supplemental") if n == 2 else None,
                 "wrong_path": lambda n, rep: rep["invocation"].update(sourceTurns="/elsewhere.json") if n == 2 else None}
        for name, edit in edits.items():
            calls = []
            self.assertEqual(self.env.run(name, live=True, runner=self.fake(calls, edit=edit)), 6, name)
            self.assertLessEqual(len(calls), 3)
            self.assertFalse((self.tmp / name / "result.json").exists())

    def test_any_inventory_mutation_after_a_stage_stops_the_run(self):
        copy = self.tmp / "runner-copy.py"
        shutil.copy(HERE / "run-longmemeval-statement-full500.py", copy)
        rmod = loadmod("statement_full500_runner_copy", copy)
        out = lambda name: self.tmp / name
        muts = {"runner": (lambda: copy.write_text(copy.read_text() + "\n# x\n"), rmod), "protocol": (lambda: self.env.protocol.write_text("edited"), None),
                "turns": (lambda: self.env.turns.write_text(self.env.turns.read_text() + " "), None),
                "src": (lambda: (self.env.root / "src/a.ts").write_text("changed"), None),
                "supervisor": (lambda: (self.env.root / "benchmark/run-longmemeval-additive-trial.py").write_text("x"), None),
                "block": (lambda: (out("m_block") / "blocks/block-0/input.json").write_text("{}"), None),
                "node": (lambda: self.env.node.write_text("other"), None),
                "pilot": (lambda: self.env.pilotfile.write_text(self.env.pilotfile.read_text() + " "), None),
                "dgx": (lambda: self.env.dgx.write_text("tampered launcher"), None)}
        for name, (change, rmod_) in muts.items():
            calls = []
            self.assertEqual(self.env.run(f"m_{name}", live=True, rmod=rmod_, runner=self.fake(calls, after=lambda n, c=change: c() if n == 1 else None)), 3, name)
            self.assertEqual((len(calls), self.env.state(f"m_{name}")["status"]), (1, "inventory_mismatch"), name)
            self.assertFalse((out(f"m_{name}") / "result.json").exists())
            if name == "turns": self.env.write_turns(self.env.pins["input_sha"])
            if name == "protocol": self.env.protocol.write_text("protocol")
            if name == "node": self.env.node.write_text("node")
            if name == "pilot": self.env.pilotfile.write_text(json.dumps(self.env.pilot_inv()))
            if name == "dgx": self.env.dgx.write_text("dgx launcher")
            if name == "src": (self.env.root / "src/a.ts").write_text("a")
            if name == "supervisor": shutil.copy(HERE / "run-longmemeval-additive-trial.py", self.env.root / "benchmark/run-longmemeval-additive-trial.py")


class Journal(Base):
    def stop(self, name, mut):
        calls = []
        code = self.env.run(name, live=True, runner=self.fake(calls, jmut=lambda n, j, p: mut(j, p) if n == 2 else None))
        self.assertEqual((code, len(calls)), (6, 2), name)
        st = self.env.state(name)
        self.assertEqual((st["status"], st["stages"]["1"]["status"]), ("stage_journal_invalid", "journal_invalid"), name)
        self.assertTrue(st["stages"]["1"]["problems"], name)
        self.assertFalse((self.tmp / name / "result.json").exists())
        self.assertEqual(st["progress"], {"denominator": 500, "scored_rows": 3, "correct_among_scored": 3, "remaining": 497, "valid_stages": 1, "total_stages": 167})
        self.assertEqual((st["partial"]["valid_stages"], st["partial"]["scored_rows"], st["partial"]["claimable"]), (1, 3, False))  # the bad stage is never scored

    def test_missing_or_mutated_journal_and_progress_stop_the_run(self):
        def setidx(i, v): return lambda j, p: edit_lines(j, lambda rows: rows[i].update(index=v))
        def flip(j, p): edit_lines(j, lambda rows: rows[0].update(correct=not rows[0]["correct"]))
        def prog(**kw): return lambda j, p: p.write_bytes(json.dumps({**json.loads(p.read_bytes()), **kw}).encode())
        cases = {"no_journal": lambda j, p: j.unlink(), "no_progress": lambda j, p: p.unlink(), "empty_journal": lambda j, p: j.write_bytes(b""),
                 "no_trailing_lf": lambda j, p: j.write_bytes(j.read_bytes().rstrip(b"\n")), "blank_line": lambda j, p: j.write_bytes(j.read_bytes() + b"\n"),
                 "not_json": lambda j, p: j.write_bytes(j.read_bytes() + b"{bad\n"), "dup_index": setidx(1, 0), "str_index": setidx(0, "0"),
                 "bool_index": setidx(0, True), "gap_index": setidx(2, 7), "missing_row": lambda j, p: edit_lines(j, lambda rows: rows.pop()),
                 "extra_row": lambda j, p: edit_lines(j, lambda rows: rows.append({**rows[0], "index": 3})), "mutated_row": flip,
                 "swapped_rows": lambda j, p: edit_lines(j, lambda rows: rows[0].update({"question_id": rows[1]["question_id"]})),
                 "array_row": lambda j, p: edit_lines(j, lambda rows: rows.__setitem__(0, [0])), "progress_partial": prog(status="partial"),
                 "progress_summary": prog(summary={"errors": 1}), "progress_elapsed": prog(elapsed_s=-1), "progress_bool_elapsed": prog(elapsed_s=True),
                 "progress_junk": lambda j, p: p.write_bytes(b"{"), "progress_list": lambda j, p: p.write_bytes(b"[]")}
        for name, mut in cases.items(): self.stop(name, mut)

    def test_journal_rows_may_finish_out_of_order_and_split_only_on_physical_lf(self):
        tweak = lambda n, rows, arm: rows[0].update(answer="a\u2028b\u0085c")  # Unicode line separators are not row boundaries
        seen = []
        def mut(n, j, p):
            edit_lines(j, lambda rows: rows.reverse())  # concurrent pipelines finish in any order
            seen.append(j.read_bytes())
        self.assertEqual(self.env.run(live=True, runner=self.fake([], tweak=tweak, jmut=mut)), 0)
        self.assertEqual(len(seen), 167)
        self.assertEqual(self.env.state()["progress"], {"denominator": 500, "scored_rows": 500, "correct_among_scored": 500, "remaining": 0, "valid_stages": 167, "total_stages": 167})
        self.assertIn("\u2028".encode(), seen[0])
        self.assertEqual(len(seen[0].split(b"\n")) - 1, 3)  # three physical rows, though str.splitlines would give more
        self.assertEqual(len(seen[0].decode().splitlines()), 5)
        self.assertEqual(self.env.state()["status"], "comparison_invalid")

    def test_problem_reporter_directly(self):
        d = self.tmp / "rep"
        d.mkdir()
        report = d / "report.json"
        rows = [{"question_id": "a", "x": 1}, {"question_id": "b"}]
        report.write_text(json.dumps({"results": rows, "summary": {"recorded": 2}}))
        Path(f"{report}.jsonl").write_bytes(b"".join((json.dumps({"index": i, **r}) + "\n").encode() for i, r in enumerate(rows)))
        Path(f"{report}.progress.json").write_text(json.dumps({"status": "complete", "elapsed_s": 0, "summary": {"recorded": 2}}))
        self.assertEqual(R.journal_problems(report), [])
        report.write_text("{")
        self.assertTrue(R.journal_problems(report))
        report.write_text(json.dumps({"summary": {}}))
        self.assertEqual(R.journal_problems(report), ["report results missing"])
        self.assertTrue(R.journal_problems(d / "absent.json"))


class RealBlock(unittest.TestCase):
    """A runner-style block of the real source-turns builder output through the actual TS QA path and Python validators."""
    def test_block_subset_verifies_against_the_parent_input_and_generation_sees_no_raw_labels(self):
        real = loadmod("statement_real_row_for_full500", HERE / "test_run_longmemeval_statement_real_row.py")
        M, SV = R.load_trial(ROOT), None
        SV = M.statement_validation()
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="recall-full500-real-") as td:
            d = Path(td)
            env = {**os.environ, "REAL_ROW_DIR": td, "REAL_ROW_QIDS": json.dumps(real.QIDS), "TMPDIR": td}
            r = subprocess.run([shutil.which("node") or "node", "--import", "tsx", "--input-type=module", "-e", real.REAL_JS], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            in_sha, rank_sha = M.sha(d / "input.json"), M.sha(d / "rankings.json")
            block = [real.QIDS[0]]
            M.write_json(d / "block-input.json", M.subset_input(M.load(d / "input.json"), block, in_sha))
            M.write_json(d / "block-rankings.json", M.subset_rankings(M.load(d / "rankings.json"), block, rank_sha))
            js = r"""import {resolve, join} from "node:path"; import {pathToFileURL} from "node:url"; import {writeFileSync} from "node:fs";
const {runEvaluation} = await import(pathToFileURL(resolve("benchmark/longmemeval-qa.ts")).href);
const dir = process.env.REAL_ROW_DIR, p = (n) => join(dir, n), prompts = [];
const call = (text) => ({text, error: null, attempts: 1, elapsed_ms: 1, model: "stub", usage: null, prompt_sha256: "stub"});
const stub = async (kind, prompt) => { if (kind === "answer") { prompts.push(prompt); return call('{"reasoning":"quoted","answer":"kiln pottery"}'); }
  return call(kind === "premise" ? '{"correct":true,"reason":"supported"}' : '{"correct":true,"reason":"matches"}'); };
await runEvaluation({input: p("block-input.json"), rankings: p("block-rankings.json"), out: p("block-report.json"), provider: "qwen-local", retrieval: "cached", concurrency: 3,
  contextChars: 180000, topK: 20, evidence: "statements", requestMode: "robust", answerCheck: "premise", reasoningEffort: "adaptive",
  maxOutputTokens: 16384, evidencePolicy: "system", answerPolicy: "minimal", answerRecovery: "longer-timeout-transport", sourceTurns: p("turns.json")}, stub);
writeFileSync(p("prompts.json"), JSON.stringify(prompts));
"""
            r = subprocess.run([shutil.which("node") or "node", "--import", "tsx", "--input-type=module", "-e", js], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            rep, prompts = M.load(d / "block-report.json"), M.load(d / "prompts.json")
            expect = {"path": str(d / "turns.json"), "sha256": M.sha(d / "turns.json"), "input_sha256": in_sha, "raw_dataset_sha256": M.load(d / "input.json")["provenance"]["dataset_sha256"]}
            self.assertEqual(rep["source_turns_manifest"], {**expect, "verified_cases": 1})  # bound to the parent input, not the block bytes
            self.assertNotEqual(in_sha, M.sha(d / "block-input.json"))
            self.assertEqual(SV.turns_problems(rep, "candidate", expect, 1), [])
            self.assertEqual(SV.report_problems(rep, "candidate"), [])
            self.assertEqual([x for r_ in rep["results"] for x in M.evidence_problems(r_, "candidate", "statements")], [])
            self.assertEqual(len(prompts), 1)
            for bad in ("real-a", "real-b", "src-real", "speaker_spans", "Lexical", "occurrence", "has_answer", "question_type"):
                self.assertNotIn(bad, prompts[0])
            self.assertIn("## Memory", prompts[0])


if __name__ == "__main__":
    unittest.main()
