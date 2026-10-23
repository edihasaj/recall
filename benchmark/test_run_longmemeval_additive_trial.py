"""Offline tests for run-longmemeval-additive-trial.py (no model calls, fake runner)."""
import hashlib, importlib.util, io, json, os, sys, tempfile, unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("additive_trial", Path(__file__).with_name("run-longmemeval-additive-trial.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sspec = importlib.util.spec_from_file_location("additive_support", Path(__file__).with_name("longmemeval_additive_test_support.py"))
S = importlib.util.module_from_spec(sspec)
sspec.loader.exec_module(S)
call, good_row, effort_of = S.call, S.good_row, S.effort_of
INSTR = {"control": {"i"}, "candidate": {"i"}}


def fake_efforts(a, cases, ids): return {q: effort_of(q) for q in ids}


class Env:
    """A tiny frozen source tree, data dir and protocol with 110 cases, 30 of them unanswerable."""
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.root = tmp / "root"
        for d in ("src", "benchmark", "drizzle", "node_modules"): (self.root / d).mkdir(parents=True)
        (self.root / "src/a.ts").write_text("a")
        (self.root / "benchmark" / "longmemeval-inference-policy.ts").write_text("policy")
        (self.root / "node_modules/m.js").write_text("m")
        os.symlink("m.js", self.root / "node_modules/link.js")
        for f in mod.TREE_FILES: (self.root / f).write_text("{}")
        self.node, self.protocol = tmp / "node", tmp / mod.PROTOCOL_NAME
        self.node.write_text("node")
        self.protocol.write_text("protocol")
        self.data = tmp / "data"
        self.data.mkdir()
        qs = [f"q{i:03d}" for i in range(110)]
        self.abs = {q for i, q in enumerate(qs) if i % 11 in (0, 1, 2)}
        cases = [{"question_id": q, "is_abstention": q in self.abs, "question": "Q" + q} for q in qs]
        (self.data / mod.INPUT).write_text(json.dumps({"provenance": {"dataset_sha256": "d"}, "cases": cases}))
        (self.data / mod.RANKINGS).write_text(json.dumps({"status": "complete", "dataset_sha256": "d", "selected_question_ids": qs, "results": [{"question_id": q} for q in qs]}))
        base = {"hashes": {"input": mod.sha(self.data / mod.INPUT), "rankings": mod.sha(self.data / mod.RANKINGS)}}
        (self.data / mod.BASELINE).write_text(json.dumps(base))
        self.base_sha = mod.sha(self.data / mod.BASELINE)
        sel = mod.derive_selection(cases)
        self.ids = sel["selected_question_ids"]
        self.sel_abs = [q for q in self.ids if q in self.abs]
        self.sel_ans = [q for q in self.ids if q not in self.abs]

    def run(self, name="out", live=False, runner=None, key=True, efforts=True, protocol=None, out=None):
        argv = ["--source-root", str(self.root), "--data-dir", str(self.data), "--node", str(self.node),
                "--out-dir", str(out or self.tmp / name), "--protocol", str(protocol or self.protocol)] + (["--live"] if live else [])
        env = {"DGX_KEY_FILE": "/unused"} if key else {}
        patches = [mock.patch.object(mod, "BASELINE_SHA", self.base_sha), mock.patch.dict(os.environ, env)]
        if efforts: patches.append(mock.patch.object(mod, "derive_efforts", fake_efforts))
        with redirect_stderr(io.StringIO()):
            for p in patches: p.start()
            try:
                if not key: os.environ.pop("DGX_KEY_FILE", None)
                return mod.main(argv, runner)
            finally:
                for p in reversed(patches): p.stop()

    def state(self, name="out"): return json.loads((self.tmp / name / "state.json").read_text())


def fake_runner(calls, correct, tweak=None, after=None, edit=None):
    def run(cmd, cwd, env, stdout, stderr):
        calls.append(cmd)
        flags = dict(zip(cmd[7::2], cmd[8::2]))
        arm = "candidate" if flags["--evidence"] == "additive" else "control"
        cases = json.loads(Path(flags["--input"]).read_text())["cases"]
        rows = [good_row(c["question_id"], correct(arm, c["question_id"]), c["is_abstention"], arm) for c in cases]
        if tweak: tweak(len(calls), rows, arm)
        inv = {mod.INVOCATION[f]: (int(v) if v.isdigit() else v) for f, v in flags.items() if f in mod.INVOCATION}
        inv.update(input=flags["--input"], rankings=flags["--rankings"], out=flags["--out"], retrieval="cached")
        report = {"status": "complete", "comparison_valid": True, "invocation": inv, "results": rows, "answer_instructions": {"policy": "minimal", "sha256": "i"},
                  "summary": {"errors": 0, "planned": len(rows), "recorded": len(rows)}}
        if edit: edit(len(calls), report)
        Path(flags["--out"]).write_text(json.dumps(report))
        if after: after(len(calls))
        return 0
    return run


class Selection(unittest.TestCase):
    def cases(self, n_abs=30, n_ans=80):
        return [{"question_id": f"a{i}", "is_abstention": True, "correct": i % 2 == 0} for i in range(n_abs)] + \
               [{"question_id": f"n{i}", "is_abstention": False, "correct": i % 2 == 0} for i in range(n_ans)]

    def test_all_abstentions_plus_first_seventy_answerable_by_hash(self):
        cases = self.cases()
        sel = mod.derive_selection(cases)
        key = lambda q: hashlib.sha256(mod.SEED.encode() + b"\0" + q.encode()).hexdigest()
        want_ans = sorted((c["question_id"] for c in cases if not c["is_abstention"]), key=key)[:70]
        self.assertEqual(sel["answerable_ids"], want_ans)
        self.assertEqual(sorted(sel["abstention_ids"]), sorted(f"a{i}" for i in range(30)))
        self.assertEqual(sel["selected_question_ids"], sorted(want_ans + sel["abstention_ids"], key=key))
        self.assertEqual(len(sel["selected_question_ids"]), 100)

    def test_selection_ignores_correctness_and_other_fields(self):
        cases = self.cases()
        flipped = [{**c, "correct": not c["correct"], "reference": "x", "gold_session_ids": ["g"]} for c in cases]
        self.assertEqual(mod.derive_selection(cases), mod.derive_selection(flipped))

    def test_bad_counts_flags_and_duplicates_fail_closed(self):
        with self.assertRaises(mod.Failure): mod.derive_selection(self.cases(n_abs=29))
        with self.assertRaises(mod.Failure): mod.derive_selection(self.cases(n_ans=69))
        bad = self.cases()
        bad[0]["is_abstention"] = "yes"
        with self.assertRaises(mod.Failure): mod.derive_selection(bad)
        with self.assertRaises(mod.Failure): mod.derive_selection(self.cases() + [{"question_id": "a0", "is_abstention": True}])


class Schedule(unittest.TestCase):
    def test_blocks_alternate_arm_order_and_final_block_is_partial(self):
        ids = [f"q{i}" for i in range(100)]
        st = mod.schedule(ids)
        self.assertEqual(len(st), 68)
        self.assertEqual([s["arm"] for s in st[:4]], ["control", "candidate", "candidate", "control"])
        self.assertEqual([len(s["ids"]) for s in st[-2:]], [1, 1])
        self.assertEqual(st[-1]["block"], 33)
        for b in range(34): self.assertEqual({s["arm"] for s in st[2 * b:2 * b + 2]}, {"control", "candidate"})
        for arm in ("control", "candidate"): self.assertEqual([q for s in st if s["arm"] == arm for q in s["ids"]], ids)
        self.assertEqual([s["index"] for s in st], list(range(68)))

    def test_wrong_size_or_duplicates_rejected(self):
        with self.assertRaises(mod.Failure): mod.schedule([f"q{i}" for i in range(99)])
        with self.assertRaises(mod.Failure): mod.schedule(["a"] * 100)


class Validation(unittest.TestCase):
    ids = ["q000", "q001"]
    init = {"q000": "high", "q001": "low"}

    def problems(self, rows, arm="control", abs_ids=frozenset()): return mod.check_rows(rows, self.ids, set(abs_ids), arm, self.init)

    def mutate(self, f, arm="control"):
        r = good_row("q000", arm=arm)
        f(r)
        return self.problems([r, good_row("q001", arm=arm)], arm)

    def test_clean_rows_pass_for_both_arms(self):
        self.assertEqual(self.problems([good_row("q000"), good_row("q001")]), [])
        self.assertEqual(self.problems([good_row("q000", arm="candidate"), good_row("q001", arm="candidate")], "candidate"), [])

    def test_bad_rows_are_rejected(self):
        m = self.mutate
        self.assertTrue(m(lambda r: r["premise_call"].update(error="timeout")))
        self.assertTrue(m(lambda r: r.update(premise_recorded=None)))
        self.assertTrue(m(lambda r: r.update(premise_recorded="true")))
        self.assertTrue(m(lambda r: r.update(premise_call=None)))
        self.assertTrue(m(lambda r: r.update(correct=None)))
        self.assertTrue(m(lambda r: r.update(error="boom")))
        self.assertTrue(m(lambda r: r.update(evidence={})))
        self.assertTrue(m(lambda r: r["evidence"].pop("sources")))
        self.assertTrue(m(lambda r: r["answer_call"].pop("prompt_sha256")))

    def test_ids_duplicates_and_abstention_flag(self):
        self.assertTrue(self.problems([good_row("q000")]))
        self.assertTrue(self.problems([good_row("q000"), good_row("q000")]))
        self.assertTrue(self.problems([good_row("q000"), good_row("zz")]))
        self.assertTrue(self.problems([good_row("q000"), good_row("q001")], abs_ids={"q000"}))

    def test_arm_specific_additive_diagnostics(self):
        self.assertTrue(self.mutate(lambda r: r["evidence"].update(additive={"base_chars": 1, "extra_chars": 0})))  # control must not carry them
        self.assertTrue(self.mutate(lambda r: r["evidence"].pop("additive"), "candidate"))
        self.assertTrue(self.mutate(lambda r: r["evidence"]["additive"].update(base_chars="3"), "candidate"))

    def test_initial_effort_is_per_original_question(self):
        self.assertTrue(self.mutate(lambda r: r.update(answer_call=call("low", adaptive=True))))  # q000 must start high
        self.assertTrue(self.mutate(lambda r: r.update(answer_call=call("adaptive")), "candidate"))
        self.assertTrue(self.mutate(lambda r: r.update(answer_call=call("high", tokens=4096, adaptive=True))))
        self.assertTrue(self.mutate(lambda r: r["answer_call"]["request_config"].update(requested_reasoning_effort="high")))

    def test_premise_judge_and_model_are_fixed(self):
        self.assertTrue(self.mutate(lambda r: r.update(premise_call=call("none", 4096))))
        self.assertTrue(self.mutate(lambda r: r.update(judge_call=call("low", 4096))))
        self.assertTrue(self.mutate(lambda r: r["judge_call"].update(model="other")))

    def test_recovery_rules(self):
        def retry(first, error, final, prompt="pq000control"):
            def f(r): r.update(failed_answer_call=call(first, error=error, usage=False, prompt="pq000control"), answer_call=call(final, prompt=prompt), answer_recovered=True)
            return f
        self.assertEqual(self.mutate(retry("high", "timeout", "high")), [])
        self.assertTrue(self.mutate(retry("high", "timeout", "low")))
        self.assertEqual(self.mutate(retry("high", "response_not_completed", "low")), [])
        self.assertTrue(self.mutate(retry("high", "request_failed", "high")))
        self.assertTrue(self.mutate(retry("high", "timeout", "high", prompt="other")))  # recovered prompt must match
        self.assertTrue(self.mutate(lambda r: r.update(answer_recovered=True)))

    def test_transport_retries_must_repeat_same_settings(self):
        def retries(n, **kw):
            return lambda r: r["answer_call"].update(transport_failures=[call("high", error="request_failed", usage=False, adaptive=True, **{"prompt": "pq000control", **kw}) for _ in range(n)])
        self.assertEqual(self.mutate(retries(3)), [])
        self.assertTrue(self.mutate(retries(4)))
        self.assertTrue(self.mutate(retries(1, prompt="other")))


class Parity(unittest.TestCase):
    def pair(self, q="q001"): return good_row(q), good_row(q, arm="candidate")

    def test_exact_prefix_and_sources_pass(self):
        self.assertEqual(mod.parity_problems(*self.pair()), [])

    def test_non_bmp_text_uses_utf16_units_like_the_typescript_producer(self):
        c, k = self.pair()
        c["evidence"]["text"] = "\U0001F600 " + c["evidence"]["text"]  # one code point, two UTF-16 units
        k["evidence"]["text"] = c["evidence"]["text"] + "\n\nextra"
        k["evidence"]["additive"]["base_chars"] = len(c["evidence"]["text"]) + 1
        self.assertEqual(mod.parity_problems(c, k), [])
        k["evidence"]["additive"]["base_chars"] = len(c["evidence"]["text"])  # code-point count must not pass
        self.assertIn("candidate base prefix differs from control evidence", mod.parity_problems(c, k))

    def test_prefix_source_and_length_drift_fail(self):
        c, k = self.pair(); k["evidence"]["text"] = "X" + k["evidence"]["text"][1:]
        self.assertIn("candidate base prefix differs from control evidence", mod.parity_problems(c, k))
        c, k = self.pair(); k["evidence"]["additive"]["base_chars"] += 1
        self.assertTrue(mod.parity_problems(c, k))
        c, k = self.pair(); k["evidence"]["sources"][5] = {"id": "other"}
        self.assertIn("candidate first 20 sources differ from control metadata", mod.parity_problems(c, k))
        c, k = self.pair(); c["evidence"]["sources"].pop()
        self.assertTrue(mod.parity_problems(c, k))
        self.assertTrue(mod.parity_problems(None, k))


class ReportValidity(unittest.TestCase):
    ids, init = ["q000"], {"q000": "high"}

    def report(self, arm="control", **over):
        flags = mod.arm_flags(arm)
        inv = {mod.INVOCATION[f]: (int(v) if v.isdigit() else v) for f, v in flags.items() if f in mod.INVOCATION}
        inv.update(input="i", rankings="r", out="o", retrieval="cached")
        return {"status": "complete", "comparison_valid": True, "invocation": inv, "results": [good_row("q000", arm=arm)],
                "summary": {"errors": 0, "planned": 1, "recorded": 1}, **over}

    def check(self, arm="control", **over):
        return mod.check_report(self.report(arm, **over), self.ids, set(), arm, self.init, {"input": "i", "rankings": "r", "out": "o"})

    def test_valid_report_passes_and_comparison_valid_must_be_true(self):
        self.assertEqual(self.check(), [])
        self.assertEqual(self.check("candidate"), [])
        for bad in (False, None, "true", 1):
            self.assertTrue(any("comparison_valid" in p for p in self.check(comparison_valid=bad)), bad)
        rep = self.report()
        del rep["comparison_valid"]
        self.assertTrue(mod.check_report(rep, self.ids, set(), "control", self.init, {"input": "i", "rankings": "r", "out": "o"}))


class Usage(unittest.TestCase):
    def test_failed_and_unknown_usage_calls_are_kept(self):
        r = good_row("q000", arm="candidate")
        r.update(failed_answer_call=call("high", error="timeout", usage=False, prompt="pq000candidate"), answer_recovered=True)
        r["answer_call"].update(transport_failures=[call("high", error="request_failed", usage=False, prompt="pq000candidate")])
        u = mod.usage([r])
        self.assertEqual(u["physical_calls"], {"answer_call": 2, "failed_answer_call": 1, "premise_call": 1, "judge_call": 1})
        self.assertEqual(u["unknown_usage_calls"], {"answer_call": 1, "failed_answer_call": 1})
        self.assertEqual(u["tokens"]["total.input"], 30)
        self.assertEqual(u["fallbacks"][0]["failed_effort"], "high")


class Compare(unittest.TestCase):
    ids = [f"q{i:03d}" for i in range(6)]
    abs_ids = {"q000", "q001"}
    init = {q: effort_of(q) for q in ids}

    def rows(self, correct, arm): return {q: good_row(q, q in correct, q in self.abs_ids, arm) for q in self.ids}

    def compare(self, control, candidate, instr=INSTR):
        c = self.rows(control, "control") if isinstance(control, set) else control
        k = self.rows(candidate, "candidate") if isinstance(candidate, set) else candidate
        return mod.compare(self.ids, c, k, self.abs_ids, self.init, instr)

    def test_pass_needs_net_two_and_lists_every_gain_and_loss_for_review(self):
        r = self.compare({"q000", "q005"}, {"q000", "q002", "q003", "q004"})
        self.assertTrue(r["advancement_screen_passed"])
        self.assertEqual((r["gains"], r["losses"], r["net"]), (["q002", "q003", "q004"], ["q005"], 2))
        self.assertEqual(r["source_review"], {"required": True, "status": "pending", "gains": ["q002", "q003", "q004"], "losses": ["q005"]})
        self.assertNotEqual(r["answer_prompt_sha256"]["q003"]["control"], r["answer_prompt_sha256"]["q003"]["candidate"])  # prompts differ and are recorded

    def test_net_below_two_fails(self):
        self.assertFalse(self.compare({"q000"}, {"q000", "q003"})["checks"]["net_gain_at_least_2"])

    def test_abstention_pair_loss_fails_despite_equal_totals(self):
        r = self.compare({"q000"}, {"q001", "q003", "q004", "q005"})
        self.assertEqual(r["abstention_losses"], ["q000"])
        self.assertFalse(r["checks"]["no_abstention_pair_loss"])
        self.assertFalse(r["advancement_screen_passed"])

    def test_parity_failure_blocks_pass(self):
        cand = self.rows({"q000", "q003", "q004"}, "candidate")
        cand["q002"]["evidence"]["sources"][0] = {"id": "x"}
        r = self.compare({"q000"}, cand)
        self.assertEqual(list(r["prefix_or_source_parity_failures"]), ["q002"])
        self.assertFalse(r["advancement_screen_passed"])

    def test_unclean_or_missing_rows_block_pass(self):
        cand = self.rows({"q000", "q003", "q004"}, "candidate")
        cand["q005"]["premise_recorded"] = None
        self.assertFalse(self.compare({"q000"}, cand)["checks"]["all_rows_present_error_free"])
        cand = self.rows({"q000", "q003", "q004"}, "candidate")
        del cand["q005"]
        self.assertFalse(self.compare({"q000"}, cand)["advancement_screen_passed"])

    def test_answer_instructions_must_match(self):
        k = {"q000", "q003", "q004"}
        self.assertFalse(self.compare({"q000"}, k, {"control": {"i"}, "candidate": {"j"}})["advancement_screen_passed"])
        self.assertFalse(self.compare({"q000"}, k, {"control": {"i"}, "candidate": {"i", "j"}})["advancement_screen_passed"])
        self.assertFalse(self.compare({"q000"}, k, None)["checks"]["answer_instructions_match"])


class Supervisor(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(dir='/tmp', prefix='recall-additive-test-')
        self.addCleanup(self.td.cleanup)
        self.env = Env(Path(self.td.name))
        self.out = self.env.tmp / "out"

    def test_existing_out_dir_is_refused_untouched(self):
        self.out.mkdir()
        (self.out / "keep").write_text("x")
        self.assertEqual(self.env.run(), 4)
        self.assertEqual([p.name for p in self.out.iterdir()], ["keep"])

    def test_out_dir_inside_frozen_root_is_refused_and_not_created(self):
        inside = self.env.root / "out"
        self.assertEqual(self.env.run(out=inside), 2)
        self.assertFalse(inside.exists())

    def test_protocol_must_be_explicit_existing_and_named(self):
        wrong = self.env.tmp / "OTHER.md"
        wrong.write_text("x")
        with self.assertRaises(SystemExit): self.env.run(protocol=wrong)
        self.protocol_gone = self.env.protocol.unlink()
        with self.assertRaises(SystemExit): self.env.run()
        self.assertFalse(self.out.exists())

    def test_prepare_makes_no_calls_and_records_selection_before_any_run(self):
        calls = []
        self.assertEqual(self.env.run(runner=fake_runner(calls, lambda *a: True)), 0)
        self.assertEqual(calls, [])
        st = self.env.state()
        self.assertEqual((st["status"], st["mode"], st["selected_question_ids"], len(st["planned_commands"])), ("prepared", "prepare", self.env.ids, 68))
        self.assertFalse((self.out / "stages").exists())
        sel = json.loads((self.out / "selection.json").read_text())
        self.assertEqual((sel["count"], sel["abstention_count"], sel["answerable_count"], sel["baseline_sha256"]), (100, 30, 70, self.env.base_sha))
        self.assertEqual(sel["selected_question_ids"], self.env.ids)
        self.assertEqual(sel["input_sha256"], mod.sha(self.env.data / mod.INPUT))
        eff = json.loads((self.out / "efforts.json").read_text())["initial_effort"]
        self.assertEqual(eff, {q: effort_of(q) for q in self.env.ids})
        sub = json.loads((self.out / "blocks/block-33/input.json").read_text())
        self.assertEqual([c["question_id"] for c in sub["cases"]], self.env.ids[99:])
        inv = json.loads((self.out / "inventory.json").read_text())
        self.assertEqual(len(st["block_sha256"]), 68)
        self.assertIn("block:block-0/rankings.json", inv)
        self.assertEqual(inv["selection"], mod.sha(self.out / "selection.json"))
        cmds = st["planned_commands"]
        self.assertEqual([c[c.index("--evidence") + 1] for c in cmds[:4]], ["supplemental", "additive", "additive", "supplemental"])
        for c in cmds: self.assertEqual(c[c.index("--reasoning-effort") + 1], "adaptive")
        self.assertEqual(self.env.run("out"), 4)

    def test_baseline_binding_failure_stops_before_selection(self):
        (self.env.data / mod.INPUT).write_text((self.env.data / mod.INPUT).read_text() + " ")
        self.assertEqual(self.env.run(), 2)
        self.assertEqual(self.env.state()["status"], "input_or_rankings_not_baseline_bound")
        self.assertFalse((self.out / "selection.json").exists())

    def test_effort_derivation_failure_fails_closed_after_selection_is_recorded(self):
        self.assertEqual(self.env.run(efforts=False), 2)  # the "node" file is not executable
        self.assertEqual(self.env.state()["status"], "effort_derivation_failed")
        self.assertTrue((self.out / "selection.json").exists())
        self.assertFalse((self.out / "efforts.json").exists() or (self.out / "blocks").exists())

    def test_live_requires_key_file_after_reserving_state(self):
        calls = []
        self.assertEqual(self.env.run(live=True, key=False, runner=fake_runner(calls, lambda *a: True)), 7)
        self.assertEqual((self.env.state()["status"], calls), ("dgx_key_file_unset", []))
        self.assertTrue((self.out / "selection.json").exists() and (self.out / "inventory.json").exists())
        self.assertFalse((self.out / "stages").exists())

    def test_live_pass_reports_pending_source_review(self):
        gain = set(self.env.sel_ans[:3])
        calls = []
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda arm, q: arm == "candidate" or q not in gain)), 0)
        self.assertEqual(len(calls), 68)
        res = json.loads((self.out / "result.json").read_text())
        self.assertEqual((res["status"], res["net"], sorted(res["gains"]), res["strata"]), ("pending_source_review", 3, sorted(gain), {"abstention": 30, "answerable": 70}))
        self.assertTrue(res["advancement_screen_passed"] and res["checks"]["base_prefix_and_source_parity"])
        self.assertEqual(res["source_review"]["status"], "pending")
        self.assertEqual(res["usage"]["candidate"]["physical_calls"]["answer_call"], 100)
        self.assertEqual(self.env.state()["status"], "pending_source_review")

    def test_live_abstention_pair_loss_fails_screen(self):
        lost, gain = self.env.sel_abs[0], set(self.env.sel_ans[:3])
        correct = lambda arm, q: q != lost if arm == "candidate" else q not in gain
        self.assertEqual(self.env.run(live=True, runner=fake_runner([], correct)), 0)
        res = json.loads((self.out / "result.json").read_text())
        self.assertEqual((res["abstention_losses"], res["status"], res["net"]), ([lost], "screen_not_passed", 2))

    def test_live_prefix_drift_fails_screen_even_with_gains(self):
        gain = set(self.env.sel_ans[:3])
        def tweak(n, rows, arm):
            if arm == "candidate": rows[0]["evidence"]["text"] = "Z" + rows[0]["evidence"]["text"][1:]
        self.assertEqual(self.env.run(live=True, runner=fake_runner([], lambda arm, q: arm == "candidate" or q not in gain, tweak=tweak)), 0)
        res = json.loads((self.out / "result.json").read_text())
        self.assertEqual((res["status"], res["checks"]["base_prefix_and_source_parity"]), ("screen_not_passed", False))

    def test_live_stops_when_report_is_not_a_valid_comparison(self):
        for i, bad in enumerate((False, "injected")):
            calls = []
            edit = lambda n, rep, bad=bad: rep.update(comparison_valid=bad) if n == 1 else None
            self.assertEqual(self.env.run(f"cv{i}", live=True, runner=fake_runner(calls, lambda *a: True, edit=edit)), 6)
            self.assertEqual(len(calls), 1)
            self.assertIn("comparison_valid", " ".join(self.env.state(f"cv{i}")["stages"]["0"]["problems"]))

    def test_live_stops_on_forged_extra_chars_or_oversized_evidence(self):
        for i, f in enumerate((lambda ev: ev["additive"].update(extra_chars=ev["additive"]["extra_chars"] + 1),
                               lambda ev: ev.update(chars=ev["chars"] + 1),
                               lambda ev: ev["sources"][20].update(used_chars=5000, full_chars=5000, ranges=[{"start": 0, "end": 5000}]))):
            calls = []
            tweak = lambda n, rows, arm, f=f: f(rows[0]["evidence"]) if arm == "candidate" else None
            self.assertEqual(self.env.run(f"ev{i}", live=True, runner=fake_runner(calls, lambda *a: True, tweak=tweak)), 6, i)
            self.assertEqual(len(calls), 2)  # control passes, the first candidate stage is rejected

    def test_validation_module_is_pinned_in_the_inventory(self):
        self.assertEqual(self.env.run(), 0)
        self.assertEqual(json.loads((self.out / "inventory.json").read_text())["validation"], mod.sha(mod.VALIDATION))

    def test_live_stops_on_premise_error(self):
        calls = []
        tweak = lambda n, rows, arm: rows[0]["premise_call"].update(error="timeout") if n == 1 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, tweak=tweak)), 6)
        self.assertEqual((len(calls), self.env.state()["status"]), (1, "stage_invalid"))
        self.assertFalse((self.out / "result.json").exists())

    def test_live_stops_when_effort_differs_from_original_question_policy(self):
        calls = []
        def tweak(n, rows, arm):
            if n == 2: rows[0]["answer_call"]["request_config"]["reasoning_effort"] = "none"
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, tweak=tweak)), 6)
        self.assertEqual(len(calls), 2)
        self.assertIn("config", " ".join(self.env.state()["stages"]["1"]["problems"]))

    def test_live_stops_on_missing_additive_diagnostics_or_instruction_drift(self):
        def tweak(n, rows, arm):
            if n == 2: rows[0]["evidence"].pop("additive")
        self.assertEqual(self.env.run(live=True, runner=fake_runner([], lambda *a: True, tweak=tweak)), 6)
        calls = []
        edit = lambda n, rep: rep["answer_instructions"].update(sha256="other") if n == 3 else None
        self.assertEqual(self.env.run("out2", live=True, runner=fake_runner(calls, lambda *a: True, edit=edit)), 6)
        self.assertEqual(len(calls), 3)
        edit = lambda n, rep: rep.pop("answer_instructions") if n == 1 else None
        self.assertEqual(self.env.run("out3", live=True, runner=fake_runner([], lambda *a: True, edit=edit)), 6)

    def test_live_stops_when_source_inventory_changes(self):
        calls = []
        after = lambda n: (self.env.root / "src/a.ts").write_text("changed") if n == 1 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, after=after)), 3)
        self.assertEqual((len(calls), self.env.state()["status"]), (1, "inventory_mismatch"))

    def test_live_stops_when_node_binary_or_protocol_or_block_changes(self):
        for i, change in enumerate((lambda: self.env.node.write_text("other"), lambda: self.env.protocol.write_text("edited"),
                                    lambda: (self.out / "blocks/block-0/input.json").write_text("{}"),
                                    lambda: (self.env.root / "node_modules/link.js").unlink())):
            self.setUp() if i else None
            calls = []
            self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, after=lambda n: change() if n == 1 else None)), 3, i)
            self.assertEqual(len(calls), 1)

    def test_live_stops_on_nonzero_exit_without_report(self):
        self.assertEqual(self.env.run(live=True, runner=lambda cmd, cwd, env, so, se: 1), 5)
        self.assertEqual(self.env.state()["status"], "stage_no_report")
        self.assertIn("stdout_sha256", self.env.state()["stages"]["0"])


if __name__ == "__main__":
    unittest.main()
