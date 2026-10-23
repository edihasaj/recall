"""Offline tests for run-longmemeval-effort-pilot.py (no model calls, fake runner)."""
import hashlib, importlib.util, io, json, os, tempfile, unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("effort_pilot", Path(__file__).with_name("run-longmemeval-effort-pilot.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
INSTR = {"control": {"i"}, "candidate": {"i"}}


def call(effort, tokens=16384, prompt="p", error=None, usage=True, **extra):
    u = {"input_tokens": 10, "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 2}} if usage else None
    return {"error": error, "model": mod.MODEL, "prompt_sha256": prompt, "usage": u, "elapsed_ms": 7, "attempts": 1,
            "request_config": {"reasoning_effort": effort, "max_output_tokens": tokens}, **extra}


def good_row(q, correct=True, is_abs=False, arm="control"):
    return {"question_id": q, "is_abstention": is_abs, "correct": correct, "error": None, "evidence": {"text": "e" + q},
            "answer_call": call(mod.INITIAL[arm], prompt="p" + q), "premise_call": call("low", 4096, "x"),
            "judge_call": call("none", 4096, "j"), "premise_recorded": True}


class Env:
    """A tiny frozen source tree, data dir and selection with 40 cases, 30 of them low effort."""
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.root = tmp / "root"
        for d in ("src", "benchmark", "drizzle", "node_modules"): (self.root / d).mkdir(parents=True)
        (self.root / "src/a.ts").write_text("a")
        (self.root / "node_modules/m.js").write_text("m")
        os.symlink("m.js", self.root / "node_modules/link.js")
        for f in mod.TREE_FILES: (self.root / f).write_text("{}")
        self.node, self.protocol = tmp / "node", tmp / "protocol.md"
        self.node.write_text("node")
        self.protocol.write_text("protocol")
        self.data = tmp / "data"
        self.data.mkdir()
        qs = [f"q{i:02d}" for i in range(40)]
        self.abs = {q for i, q in enumerate(qs) if i % 4 == 0}
        (self.data / mod.INPUT).write_text(json.dumps({"provenance": {"dataset_sha256": "d"}, "cases": [{"question_id": q, "is_abstention": q in self.abs} for q in qs]}))
        (self.data / mod.RANKINGS).write_text(json.dumps({"status": "complete", "dataset_sha256": "d", "selected_question_ids": qs, "results": [{"question_id": q} for q in qs]}))
        base = {"hashes": {"input": mod.sha(self.data / mod.INPUT), "rankings": mod.sha(self.data / mod.RANKINGS)},
                "results": [{"question_id": q, "correct": i % 2 == 0, "answer_call": {"request_config": {"reasoning_effort": "low" if i < 30 else "high"}}} for i, q in enumerate(qs)]}
        (self.data / mod.BASELINE).write_text(json.dumps(base))
        self.base_sha = mod.sha(self.data / mod.BASELINE)
        with mock.patch.object(mod, "EXPECTED_LOW", 30):
            self.ids = mod.derive_selection(base["results"])
        self.selection = tmp / "selection.json"
        self.selection.write_text(json.dumps({"seed": mod.SEED, "baseline_sha256": self.base_sha, "selected_question_ids": self.ids}))
        self.sel_abs = [q for q in self.ids if q in self.abs]
        self.sel_ans = [q for q in self.ids if q not in self.abs]

    def run(self, name="out", live=False, runner=None, key=True):
        argv = ["--source-root", str(self.root), "--data-dir", str(self.data), "--node", str(self.node), "--selection", str(self.selection),
                "--out-dir", str(self.tmp / name), "--protocol", str(self.protocol)] + (["--live"] if live else [])
        env = {"DGX_KEY_FILE": "/unused"} if key else {}
        with mock.patch.object(mod, "BASELINE_SHA", self.base_sha), mock.patch.object(mod, "EXPECTED_LOW", 30), \
                mock.patch.dict(os.environ, env), redirect_stderr(io.StringIO()):
            if not key: os.environ.pop("DGX_KEY_FILE", None)
            return mod.main(argv, runner)

    def state(self, name="out"): return json.loads((self.tmp / name / "state.json").read_text())


def fake_runner(calls, correct, tweak=None, after=None, edit=None):
    def run(cmd, cwd, env, stdout, stderr):
        calls.append(cmd)
        flags = dict(zip(cmd[7::2], cmd[8::2]))
        arm = "candidate" if flags["--reasoning-effort"] == "high" else "control"
        cases = json.loads(Path(flags["--input"]).read_text())["cases"]
        rows = [good_row(c["question_id"], correct(arm, c["question_id"]), c["is_abstention"], arm) for c in cases]
        if tweak: tweak(len(calls), rows)
        inv = {mod.INVOCATION[f]: (int(v) if v.isdigit() else v) for f, v in flags.items() if f in mod.INVOCATION}
        inv.update(input=flags["--input"], rankings=flags["--rankings"], out=flags["--out"], retrieval="cached")
        report = {"status": "complete", "invocation": inv, "results": rows, "answer_instructions": {"policy": "minimal", "sha256": "i"},
                  "summary": {"errors": 0, "planned": len(rows), "recorded": len(rows)}}
        if edit: edit(len(calls), report)
        Path(flags["--out"]).write_text(json.dumps(report))
        if after: after(len(calls))
        return 0
    return run


class ScheduleAndSelection(unittest.TestCase):
    def test_schedule_alternates_and_covers_all_ids_once_per_arm(self):
        ids = [f"q{i}" for i in range(24)]
        st = mod.schedule(ids)
        self.assertEqual(len(st), 16)
        self.assertEqual([s["arm"] for s in st[:4]], ["control", "candidate", "candidate", "control"])
        for b in range(8):
            pair = st[2 * b:2 * b + 2]
            self.assertEqual({s["arm"] for s in pair}, {"control", "candidate"})
            self.assertEqual(pair[0]["ids"], ids[3 * b:3 * b + 3])
        for arm in ("control", "candidate"):
            self.assertEqual([q for s in st if s["arm"] == arm for q in s["ids"]], ids)
        self.assertEqual([s["index"] for s in st], list(range(16)))

    def test_selection_uses_hash_order_and_ignores_correctness(self):
        rows = [{"question_id": f"q{i}", "correct": i % 2 == 0, "answer_call": {"request_config": {"reasoning_effort": "low"}}} for i in range(30)]
        flipped = [{**r, "correct": not r["correct"]} for r in rows]
        want = sorted((r["question_id"] for r in rows), key=lambda q: hashlib.sha256(mod.SEED.encode() + b"\0" + q.encode()).hexdigest())[:24]
        self.assertEqual(mod.derive_selection(rows, expected_low=30), want)
        self.assertEqual(mod.derive_selection(flipped, expected_low=30), want)
        with self.assertRaises(mod.Failure): mod.derive_selection(rows, expected_low=31)


class Validation(unittest.TestCase):
    ids = ["a", "b"]

    def problems(self, rows, abs_ids=frozenset(), arm="control"): return mod.check_rows(rows, self.ids, set(abs_ids), arm)

    def mutate(self, f, arm="control"):
        r = good_row("a", arm=arm)
        f(r)
        return self.problems([r, good_row("b", arm=arm)], arm=arm)

    def test_clean_rows_pass_for_both_arms(self):
        self.assertEqual(self.problems([good_row("a"), good_row("b")]), [])
        self.assertEqual(self.problems([good_row("a", arm="candidate"), good_row("b", arm="candidate")], arm="candidate"), [])

    def test_premise_failures_and_bad_rows_are_rejected(self):
        m = self.mutate
        self.assertTrue(m(lambda r: r["premise_call"].update(error="timeout")))
        self.assertTrue(m(lambda r: r.update(premise_recorded=None)))
        self.assertTrue(m(lambda r: r.update(premise_recorded="true")))
        self.assertTrue(m(lambda r: r.update(premise_call=None)))
        self.assertTrue(m(lambda r: r.update(correct=None)))
        self.assertTrue(m(lambda r: r.update(error="boom")))
        self.assertTrue(m(lambda r: r.update(evidence={})))
        self.assertTrue(m(lambda r: r["answer_call"].pop("prompt_sha256")))

    def test_recovered_prompt_hash_must_match_final_call(self):
        def recovered(prompt):
            return lambda r: r.update(failed_answer_call=call("low", error="timeout", usage=False, prompt=prompt), answer_recovered=True)
        self.assertTrue(self.mutate(recovered("other")))
        self.assertEqual(self.mutate(recovered("pa")), [])

    def test_missing_extra_wrong_ids_and_abstention_flag_mismatch(self):
        self.assertTrue(self.problems([good_row("a")]))
        self.assertTrue(self.problems([good_row("a"), good_row("b"), good_row("c")]))
        self.assertTrue(self.problems([good_row("a"), good_row("zz")]))
        self.assertTrue(self.problems([good_row("a"), good_row("b")], abs_ids={"a"}))


class Settings(unittest.TestCase):
    """Recorded native call settings must match the declared arm and the recovery policy."""

    def bad(self, arm, f):
        r = good_row("a", arm=arm)
        f(r)
        return mod._config_problems(r, arm)

    def test_initial_effort_must_match_arm(self):
        self.assertEqual(self.bad("candidate", lambda r: None), [])
        self.assertTrue(self.bad("candidate", lambda r: r.update(answer_call=call("low"))))  # candidate silently ran low
        self.assertTrue(self.bad("control", lambda r: r.update(answer_call=call("high"))))
        self.assertTrue(self.bad("control", lambda r: r.update(answer_call=call("adaptive"))))
        self.assertTrue(self.bad("candidate", lambda r: r.update(answer_call=call("high", tokens=4096))))

    def test_requested_effort_marker_is_allowed_only_when_it_matches_the_arm(self):
        marked = lambda arm, value: lambda r: r["answer_call"]["request_config"].update(requested_reasoning_effort=value)
        self.assertEqual(self.bad("control", marked("control", "adaptive")), [])
        self.assertEqual(self.bad("candidate", marked("candidate", "high")), [])
        self.assertTrue(self.bad("control", marked("control", "high")))
        self.assertTrue(self.bad("candidate", marked("candidate", "adaptive")))
        self.assertTrue(self.bad("control", lambda r: r["premise_call"]["request_config"].update(requested_reasoning_effort="adaptive")))
        self.assertTrue(self.bad("control", lambda r: r["answer_call"]["request_config"].update(extra=1)))

    def test_premise_judge_and_model_are_fixed(self):
        self.assertTrue(self.bad("control", lambda r: r.update(premise_call=call("none", 4096))))
        self.assertTrue(self.bad("control", lambda r: r.update(premise_call=call("low", 16384))))
        self.assertTrue(self.bad("control", lambda r: r.update(judge_call=call("low", 4096))))
        self.assertTrue(self.bad("control", lambda r: r["judge_call"].update(model="other-model")))
        self.assertTrue(self.bad("control", lambda r: r["answer_call"].update(model=None)))

    def test_timeout_retry_keeps_effort_and_incomplete_response_lowers_it(self):
        def retry(first, error, final):
            def f(r):
                r.update(failed_answer_call=call(first, error=error, usage=False, prompt="pa"), answer_call=call(final, prompt="pa"), answer_recovered=True)
            return f
        self.assertEqual(self.bad("candidate", retry("high", "timeout", "high")), [])
        self.assertTrue(self.bad("candidate", retry("high", "timeout", "low")))
        self.assertEqual(self.bad("candidate", retry("high", "response_not_completed", "low")), [])
        self.assertTrue(self.bad("candidate", retry("high", "response_not_completed", "high")))
        self.assertEqual(self.bad("control", retry("low", "timeout", "low")), [])
        self.assertEqual(self.bad("control", retry("low", "response_not_completed", "none")), [])
        self.assertTrue(self.bad("control", retry("high", "timeout", "high")))  # control's initial call was never high
        self.assertTrue(self.bad("candidate", retry("high", "request_failed", "high")))  # not a retryable error

    def test_recovered_flag_must_agree_with_failed_call(self):
        self.assertTrue(self.bad("control", lambda r: r.update(answer_recovered=True)))
        self.assertTrue(self.bad("control", lambda r: r.update(failed_answer_call=call("low", error="timeout", usage=False))))

    def test_transport_retries_must_repeat_the_same_settings(self):
        def retries(n, **kw):
            return lambda r: r["answer_call"].update(transport_failures=[call("low", error="request_failed", usage=False, **{"prompt": "pa", **kw}) for _ in range(n)])
        self.assertEqual(self.bad("control", retries(3)), [])
        self.assertTrue(self.bad("control", retries(4)))
        self.assertTrue(self.bad("control", retries(1, prompt="other")))
        self.assertTrue(self.bad("control", lambda r: r["premise_call"].update(transport_failures=[call("high", 4096, error="request_failed", usage=False)])))
        self.assertTrue(self.bad("control", lambda r: r["answer_call"].update(transport_failures=[call("low", error="timeout", usage=False, prompt="pa")])))
        self.assertTrue(self.bad("control", lambda r: r["answer_call"].update(transport_failures="bad")))


class Usage(unittest.TestCase):
    def test_counts_failed_and_transport_calls_and_reports_unknown_usage(self):
        r = good_row("a", arm="candidate")
        r.update(failed_answer_call=call("high", error="timeout", usage=False, prompt="pa"), answer_recovered=True)
        r["answer_call"].update(transport_failures=[call("high", error="request_failed", usage=False, prompt="pa")])
        u = mod.usage([r])
        self.assertEqual(u["physical_calls"], {"answer_call": 2, "failed_answer_call": 1, "premise_call": 1, "judge_call": 1})
        self.assertEqual(u["transport_failures"]["answer_call"], 1)
        self.assertEqual(u["unknown_usage_calls"], {"answer_call": 1, "failed_answer_call": 1})
        self.assertEqual({x["call"] for x in u["unknown_usage"]}, {"answer_call.transport_failures[0]", "failed_answer_call"})
        self.assertEqual(u["tokens"]["total.input"], 30)  # unmetered calls are reported unknown, never silently added as zero
        self.assertEqual(u["fallbacks"], [{"question_id": "a", "failed_effort": "high", "final_effort": "high", "recovered": True}])
        self.assertEqual(u["failed_configs"][0]["error"], "timeout")


class Compare(unittest.TestCase):
    ids = [f"q{i}" for i in range(6)]
    abs_ids = {"q0", "q1"}

    def rows(self, correct, arm):
        return {q: good_row(q, q in correct, q in self.abs_ids, arm) for q in self.ids}

    def compare(self, control, candidate, instr=INSTR):
        return mod.compare(self.ids, self.rows(control, "control") if isinstance(control, set) else control,
                           self.rows(candidate, "candidate") if isinstance(candidate, set) else candidate, self.abs_ids, instr)

    def test_equal_abstention_totals_with_paired_loss_fails(self):
        # Control gets q0, candidate gets q1: 1/2 each, but q0 is a paired loss. Candidate gains four answerable-or-q1 rows.
        r = self.compare({"q0"}, {"q1", "q3", "q4", "q5"})
        self.assertEqual(r["net"], 3)
        self.assertEqual(r["abstention_losses"], ["q0"])
        self.assertFalse(r["checks"]["no_abstention_pair_loss"])
        self.assertFalse(r["advancement_screen_passed"])

    def test_pass_requires_net_two_and_matching_prompts(self):
        r = self.compare({"q0"}, {"q0", "q3", "q4"})
        self.assertTrue(r["advancement_screen_passed"])
        self.assertEqual((r["gains"], r["losses"]), (["q3", "q4"], []))
        self.assertFalse(self.compare({"q0"}, {"q0", "q3"})["advancement_screen_passed"])
        cand = self.rows({"q0", "q3", "q4"}, "candidate")
        cand["q2"]["answer_call"]["prompt_sha256"] = "different"
        self.assertEqual(self.compare({"q0"}, cand)["prompt_or_evidence_mismatch"], ["q2"])
        cand = self.rows({"q0", "q3", "q4"}, "candidate")
        cand["q5"]["evidence"]["text"] = "different"
        self.assertFalse(self.compare({"q0"}, cand)["advancement_screen_passed"])

    def test_unclean_or_wrongly_configured_row_blocks_pass(self):
        cand = self.rows({"q0", "q3", "q4"}, "candidate")
        cand["q5"]["premise_recorded"] = None
        self.assertFalse(self.compare({"q0"}, cand)["advancement_screen_passed"])
        cand = self.rows({"q0", "q3", "q4"}, "candidate")
        cand["q5"]["answer_call"]["request_config"]["reasoning_effort"] = "low"
        self.assertFalse(self.compare({"q0"}, cand)["checks"]["all_rows_present_error_free"])

    def test_answer_instruction_hashes_must_match_across_arms(self):
        self.assertFalse(self.compare({"q0"}, {"q0", "q3", "q4"}, {"control": {"i"}, "candidate": {"j"}})["advancement_screen_passed"])
        self.assertFalse(self.compare({"q0"}, {"q0", "q3", "q4"}, {"control": {"i"}, "candidate": {"i", "j"}})["checks"]["answer_instructions_match"])
        self.assertFalse(self.compare({"q0"}, {"q0", "q3", "q4"}, None)["checks"]["answer_instructions_match"])


class Supervisor(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.env = Env(Path(self.td.name))
        self.out = self.env.tmp / "out"

    def test_existing_out_dir_is_refused_untouched(self):
        self.out.mkdir()
        (self.out / "keep").write_text("x")
        self.assertEqual(self.env.run(), 4)
        self.assertEqual([p.name for p in self.out.iterdir()], ["keep"])

    def test_prepare_makes_no_calls_and_hashes_generated_block_files(self):
        calls = []
        self.assertEqual(self.env.run(runner=fake_runner(calls, lambda *a: True)), 0)
        self.assertEqual(calls, [])
        st = self.env.state()
        self.assertEqual((st["status"], st["selected_question_ids"], len(st["planned_commands"])), ("prepared", self.env.ids, 16))
        self.assertFalse((self.out / "stages").exists())
        sub = json.loads((self.out / "blocks/block-1/input.json").read_text())
        self.assertEqual([c["question_id"] for c in sub["cases"]], self.env.ids[3:6])
        rk = json.loads((self.out / "blocks/block-1/rankings.json").read_text())
        self.assertEqual((rk["selected_question_ids"], rk["status"], rk["dataset_sha256"]), (self.env.ids[3:6], "complete", "d"))
        self.assertEqual(len(st["block_sha256"]), 16)
        self.assertEqual(st["block_sha256"]["block:block-1/input.json"], mod.sha(self.out / "blocks/block-1/input.json"))
        self.assertEqual(json.loads((self.out / "inventory.json").read_text())["block:block-7/rankings.json"], mod.sha(self.out / "blocks/block-7/rankings.json"))
        self.assertEqual(self.env.run("out"), 4)

    def test_input_and_rankings_must_match_hashes_recorded_by_baseline(self):
        (self.env.data / mod.INPUT).write_text((self.env.data / mod.INPUT).read_text() + " ")
        self.assertEqual(self.env.run(), 2)
        self.assertEqual(self.env.state()["status"], "input_or_rankings_not_baseline_bound")
        self.assertFalse((self.out / "blocks").exists())

    def test_live_requires_key_file(self):
        self.assertEqual(self.env.run(live=True, key=False, runner=fake_runner([], lambda *a: True)), 7)
        self.assertEqual(self.env.state()["status"], "dgx_key_file_unset")

    def test_live_pass_reports_pending_source_review(self):
        gain = set(self.env.sel_ans[:3])
        calls = []
        correct = lambda arm, q: arm == "candidate" or q not in gain
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, correct)), 0)
        self.assertEqual(len(calls), 16)
        self.assertEqual([c[c.index("--reasoning-effort") + 1] for c in calls[:4]], ["adaptive", "high", "high", "adaptive"])
        res = json.loads((self.out / "result.json").read_text())
        self.assertEqual((res["status"], res["net"], sorted(res["gains"])), ("pending_source_review", 3, sorted(gain)))
        self.assertTrue(res["advancement_screen_passed"] and res["checks"]["answer_instructions_match"])
        self.assertEqual(res["usage"]["candidate"]["physical_calls"]["answer_call"], 24)
        self.assertEqual(res["usage"]["candidate"]["unknown_usage_calls"], {})
        self.assertEqual(self.env.state()["status"], "pending_source_review")
        self.assertTrue((self.out / "stages/00-control/stdout.log").exists())

    def test_live_abstention_pair_loss_fails_screen_even_with_net_gain(self):
        lost = self.env.sel_abs[0]
        gain = set(self.env.sel_ans[:3])
        correct = lambda arm, q: q != lost if arm == "candidate" else q not in gain
        self.assertEqual(self.env.run(live=True, runner=fake_runner([], correct)), 0)
        res = json.loads((self.out / "result.json").read_text())
        self.assertEqual((res["abstention_losses"], res["status"]), ([lost], "screen_not_passed"))
        self.assertEqual(res["net"], 2)

    def test_live_stops_on_premise_error_in_first_stage(self):
        calls = []
        tweak = lambda n, rows: rows[0]["premise_call"].update(error="timeout") if n == 1 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, tweak=tweak)), 6)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.env.state()["status"], "stage_invalid")
        self.assertFalse((self.out / "result.json").exists())

    def test_live_stops_when_candidate_silently_runs_low(self):
        calls = []
        tweak = lambda n, rows: rows[0]["answer_call"]["request_config"].update(reasoning_effort="low") if n == 2 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, tweak=tweak)), 6)
        self.assertEqual(len(calls), 2)
        self.assertIn("config", " ".join(self.env.state()["stages"]["1"]["problems"]))

    def test_live_stops_when_answer_instructions_differ_or_are_missing(self):
        calls = []
        edit = lambda n, rep: rep["answer_instructions"].update(sha256="other") if n == 3 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, edit=edit)), 6)
        self.assertEqual(len(calls), 3)
        edit = lambda n, rep: rep.pop("answer_instructions") if n == 1 else None
        self.assertEqual(self.env.run("out2", live=True, runner=fake_runner([], lambda *a: True, edit=edit)), 6)

    def test_live_stops_when_source_inventory_changes_between_stages(self):
        calls = []
        after = lambda n: (self.env.root / "src/a.ts").write_text("changed") if n == 1 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, after=after)), 3)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.env.state()["status"], "inventory_mismatch")

    def test_live_stops_when_shared_block_input_changes_between_arms(self):
        calls = []
        after = lambda n: (self.out / "blocks/block-0/input.json").write_text("{}") if n == 1 else None
        self.assertEqual(self.env.run(live=True, runner=fake_runner(calls, lambda *a: True, after=after)), 3)
        self.assertEqual(len(calls), 1)  # the second arm never starts on altered input
        st = self.env.state()
        self.assertEqual(st["status"], "inventory_mismatch")
        self.assertIn("block:block-0/input.json", st["detail"]["first"])

    def test_live_nonzero_exit_fails_closed(self):
        def runner(cmd, cwd, env, stdout, stderr): return 1
        self.assertEqual(self.env.run(live=True, runner=runner), 5)
        self.assertEqual(self.env.state()["status"], "stage_no_report")


if __name__ == "__main__":
    unittest.main()
