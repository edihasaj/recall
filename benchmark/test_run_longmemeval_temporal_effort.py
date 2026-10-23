"""Offline tests for `--selection-policy temporal` in run-longmemeval-effort-pilot.py (no model calls, mocked router)."""
import argparse, hashlib, importlib.util, io, json, os, shutil, subprocess, tempfile, unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location("effort_pilot_tests", Path(__file__).with_name("test_run_longmemeval_effort_pilot.py"))
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)
mod, Env, fake_runner = base.mod, base.Env, base.fake_runner

TPROTO = "LONGMEMEVAL-TEMPORAL-EFFORT-PROTOCOL.md"


class TemporalEnv(Env):
    """Temporal cohort: every third of 40 cases (14, so five blocks with a partial last one)."""
    def __init__(self, tmp: Path):
        super().__init__(tmp)
        inp = json.loads((self.data / mod.INPUT).read_text())  # the router reads original question text from the pinned input
        for c in inp["cases"]: c["question"] = "question " + c["question_id"]
        (self.data / mod.INPUT).write_text(json.dumps(inp))
        baseline = json.loads((self.data / mod.BASELINE).read_text())
        baseline["hashes"]["input"] = mod.sha(self.data / mod.INPUT)
        (self.data / mod.BASELINE).write_text(json.dumps(baseline))
        self.base_sha = mod.sha(self.data / mod.BASELINE)
        (self.root / "benchmark/longmemeval-temporal-routing.ts").write_text("router")
        self.protocol = tmp / TPROTO
        self.protocol.write_text("temporal protocol")
        self.cohort = [f"q{i:02d}" for i in range(0, 40, 3)]
        self.ids = sorted(self.cohort, key=lambda q: hashlib.sha256(mod.TSEED.encode() + b"\0" + q.encode()).hexdigest())
        self.write_selection()
        self.sel_abs = [q for q in self.ids if q in self.abs]

    def write_selection(self, **over):
        sel = {"seed": mod.TSEED, "baseline_sha256": self.base_sha, "routing_sha256": mod.sha(self.root / mod.ROUTING),
               "selected_question_ids": self.ids, **over}
        self.selection.write_text(json.dumps(sel))

    def router(self, ids=None, code=0, stdout=None):
        out = json.dumps(sorted(self.cohort if ids is None else ids)) if stdout is None else stdout
        return mock.Mock(side_effect=lambda cmd, **kw: subprocess.CompletedProcess(cmd, code, out, "boom"))

    def run(self, name="out", live=False, runner=None, router=None, protocol=True, policy="temporal"):
        argv = ["--source-root", str(self.root), "--data-dir", str(self.data), "--node", str(self.node), "--selection", str(self.selection),
                "--out-dir", str(self.tmp / name), "--selection-policy", policy] + (["--protocol", str(self.protocol)] if protocol else []) + (["--live"] if live else [])
        self.router_mock = router or self.router()
        with mock.patch.object(mod, "BASELINE_SHA", self.base_sha), mock.patch.object(mod, "TEMPORAL_COUNT", len(self.cohort)), \
                mock.patch.object(mod.subprocess, "run", self.router_mock), mock.patch.dict(os.environ, {"DGX_KEY_FILE": "/unused"}), \
                redirect_stderr(io.StringIO()):
            return mod.main(argv, runner)


class TemporalSchedule(unittest.TestCase):
    def test_full_cohort_has_25_blocks_50_stages_and_a_final_partial_block(self):
        ids = [f"q{i}" for i in range(74)]
        st = mod.schedule(ids, 74)
        self.assertEqual(len(st), 50)
        self.assertEqual({s["block"] for s in st}, set(range(25)))
        self.assertEqual(st[-1]["ids"], ids[72:])
        for b in range(25):  # even blocks control first, odd blocks candidate first, each block runs both arms on the same IDs
            pair = st[2 * b:2 * b + 2]
            self.assertEqual([s["arm"] for s in pair], ["control", "candidate"] if b % 2 == 0 else ["candidate", "control"])
            self.assertEqual(pair[0]["ids"], pair[1]["ids"])
        for arm in ("control", "candidate"):
            self.assertEqual([q for s in st if s["arm"] == arm for q in s["ids"]], ids)

    def test_size_is_enforced_and_original_default_is_unchanged(self):
        with self.assertRaises(mod.Failure): mod.schedule([f"q{i}" for i in range(74)])
        with self.assertRaises(mod.Failure): mod.schedule([f"q{i}" for i in range(73)], 74)
        with self.assertRaises(mod.Failure): mod.schedule(["a"] * 74, 74)
        self.assertEqual(len(mod.schedule([f"q{i}" for i in range(24)])), 16)


class TemporalRouter(unittest.TestCase):
    def test_router_runs_in_frozen_source_with_tsx_and_only_sees_question_text(self):
        a = argparse.Namespace(node=Path("/frozen/node"), source_root=Path("/frozen/src"))
        cases = [{"question_id": f"q{i}", "question": f"t{i}", "reference": "SECRET", "is_abstention": True} for i in range(5)]
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(["q3", "q1"]), ""))
        with mock.patch.object(mod.subprocess, "run", run):
            got = mod.router_ids(a, cases)
        self.assertEqual(got, sorted(["q1", "q3"], key=lambda q: hashlib.sha256(mod.TSEED.encode() + b"\0" + q.encode()).hexdigest()))
        cmd, kw = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(cmd[:3], ["/frozen/node", "--import", "tsx"])
        self.assertEqual(kw["cwd"], Path("/frozen/src"))
        self.assertEqual(json.loads(kw["input"]), [{"id": f"q{i}", "question": f"t{i}"} for i in range(5)])
        self.assertNotIn("SECRET", kw["input"])

    def test_router_failures_fail_closed(self):
        a = argparse.Namespace(node=Path("n"), source_root=Path("."))
        cases = [{"question_id": "q1", "question": "t"}]
        for result in (subprocess.CompletedProcess([], 1, "[]", "err"), subprocess.CompletedProcess([], 0, "not json", ""),
                       subprocess.CompletedProcess([], 0, '["zzz"]', ""), subprocess.CompletedProcess([], 0, '["q1","q1"]', "")):
            with mock.patch.object(mod.subprocess, "run", return_value=result), self.assertRaises(mod.Failure) as cm: mod.router_ids(a, cases)
            self.assertEqual(cm.exception.status, "router_derivation_failed")
        with mock.patch.object(mod.subprocess, "run", side_effect=OSError("no node")), self.assertRaises(mod.Failure): mod.router_ids(a, cases)
        with self.assertRaises(mod.Failure): mod.router_ids(a, cases + cases)

    @unittest.skipUnless(shutil.which("node") and (Path(__file__).resolve().parent.parent / "node_modules/tsx").exists(), "needs node + tsx in the repo")
    def test_real_frozen_router_selects_explicit_temporal_questions_only(self):
        root = Path(__file__).resolve().parent.parent
        cases = [{"question_id": "t", "question": "What is the order of the three sports events I participated in, from earliest to latest?"},
                 {"question_id": "r", "question": "Any recommendations for what to cook, and how long should it take?"},
                 {"question_id": "p", "question": "What is my favorite color?"}]
        self.assertEqual(mod.router_ids(argparse.Namespace(node=Path(shutil.which("node")), source_root=root), cases), ["t"])


class TemporalSupervisor(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        self.env = TemporalEnv(Path(self._t.name))

    def status(self): return self.env.state()["status"]

    def test_prepare_records_policy_router_sha_cohort_claim_and_partial_final_block(self):
        self.assertEqual(self.env.run(), 0)
        st = self.env.state()
        self.assertEqual((st["status"], st["selection_policy"], st["cohort_size"]), ("prepared", "temporal", 14))
        self.assertEqual(st["routing_sha256"], mod.sha(self.env.root / mod.ROUTING))
        self.assertIn("14-question", st["claim"])
        self.assertNotIn("24-question", st["claim"])
        self.assertEqual(st["selected_question_ids"], self.env.ids)
        self.assertEqual(len(st["schedule"]), 10)
        blocks = sorted((self.env.tmp / "out/blocks").iterdir())
        self.assertEqual(len(blocks), 5)
        sizes = [len(json.loads((b / "input.json").read_text())["cases"]) for b in blocks]
        self.assertEqual(sizes, [3, 3, 3, 3, 2])
        self.assertEqual(self.env.router_mock.call_count, 1)  # preparation runs only the local router, never a model call
        self.assertEqual(len(st["planned_commands"]), 10)

    def test_protocol_must_be_explicit_and_be_the_temporal_one(self):
        e = self.env
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit): e.run("a", protocol=False)
            original = e.tmp / mod.PROTOCOLS["effort"]
            original.write_text("old")
            e.protocol = original
            with self.assertRaises(SystemExit): e.run("b")
            e.protocol = e.tmp / TPROTO
            with self.assertRaises(SystemExit): e.run("c", policy="effort")  # temporal protocol cannot be used with the original policy
        self.assertFalse((e.tmp / "a").exists() or (e.tmp / "b").exists() or (e.tmp / "c").exists())
        self.assertEqual(e.router_mock.call_count, 0)

    def test_default_policy_and_protocol_are_the_original_ones(self):
        a = mod.parse(["--source-root", "r", "--data-dir", "d", "--node", "n", "--selection", "s", "--out-dir", "o"])
        self.assertEqual(a.selection_policy, "effort")
        self.assertEqual(a.protocol.name, mod.PROTOCOLS["effort"])

    def test_manifest_mismatches_fail_closed_before_any_output(self):
        e = self.env
        cases = {"routing": {"routing_sha256": "0" * 64}, "baseline": {"baseline_sha256": "0" * 64}, "seed": {"seed": mod.SEED},
                 "order": {"selected_question_ids": list(reversed(e.ids))}, "missing": {"selected_question_ids": e.ids[:-1]}}
        want = {"routing": "routing_sha_mismatch", "baseline": "baseline_or_selection_mismatch", "seed": "baseline_or_selection_mismatch",
                "order": "selection_not_reproduced", "missing": "selection_not_reproduced"}
        for name, over in cases.items():
            e.write_selection(**over)
            self.assertEqual(e.run(name), 2, name)
            self.assertEqual(self.env.state(name)["status"], want[name], name)
            self.assertFalse((e.tmp / name / "blocks").exists(), name)

    def test_cohort_size_and_router_errors_fail_closed(self):
        e = self.env
        self.assertEqual(e.run("short", router=e.router(ids=e.cohort[:-1])), 2)
        self.assertEqual(e.state("short")["status"], "temporal_count_mismatch")
        self.assertEqual(e.run("crash", router=e.router(code=1)), 2)
        self.assertEqual(e.state("crash")["status"], "router_derivation_failed")
        self.assertEqual(e.run("junk", router=e.router(stdout="{")), 2)
        self.assertEqual(e.state("junk")["status"], "router_derivation_failed")

    def test_live_runs_both_arms_over_the_partial_final_block(self):
        calls: list = []
        e = self.env
        self.assertEqual(e.run(live=True, runner=fake_runner(calls, lambda arm, q: arm == "candidate" or q in e.ids[:2])), 0)
        st = e.state()
        self.assertEqual(len(calls), 10)
        self.assertEqual(st["status"], "pending_source_review")
        self.assertEqual([s["arm"] for s in st["schedule"][-2:]], ["control", "candidate"])
        result = json.loads((e.tmp / "out/result.json").read_text())
        self.assertEqual((result["control_correct"], result["candidate_correct"]), (2, 14))
        self.assertEqual(sorted(result["gains"]), sorted(e.ids[2:]))
        self.assertEqual(len([s for s in st["stages"].values() if s["status"] == "valid"]), 10)
        last = json.loads(Path(calls[-1][calls[-1].index("--input") + 1]).read_text())["cases"]
        self.assertEqual([c["question_id"] for c in last], e.ids[12:])


if __name__ == "__main__":
    unittest.main()
