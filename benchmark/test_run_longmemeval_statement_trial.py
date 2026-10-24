"""Offline tests for the `--candidate-evidence statements` mode of run-longmemeval-additive-trial.py (fake runner, no model calls)."""
import importlib.util, io, json, os, shutil, sys, tempfile, unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


A = load("additive_trial_tests", "test_run_longmemeval_additive_trial.py")  # reuses its tiny frozen tree; its tests are not re-exported
S, mod = A.S, A.mod
SV = mod.statement_validation()
INSTR = {"control": {"i"}, "candidate": {"i"}}
REPORT = {"mode": "original_twenty_plus_lexical_statements", "original_sources": 20, "lexical_pool": 80, "lexical_limit": 20,
          "per_source_raw_chars": 4000, "max_chars": 180000, "reserve_speaker_units": True, "helper_source_sha256": "h", "renderer_source_sha256": "r"}



def stmt_sources(q):
    s = [S.src(f"{q}-s{i}", i) for i in range(20)]
    s[3] = {**s[3], "used_chars": 50, "truncated": True, "ranges": [{"start": 10, "end": 60}]}  # ranges intentionally differ from the control
    s[7] = {**s[7], "used_chars": 0, "truncated": True, "ranges": []}  # an original source whose unit was omitted keeps its identity
    return s + [S.src(f"{q}-lex0", 100, 60), {**S.src(f"{q}-lex1", 101, 80), "used_chars": 0, "truncated": True, "ranges": []}]


def stmt_text(srcs):
    blocks = [("## Memory %d\n" % r) + "z" * s["used_chars"] for r, s in enumerate(srcs, 1) if s["used_chars"]]
    blocks[0] = "## Memory 1\n## Memory 9\n" + "z" * 88  # body quoting a header: the validator must never parse headers
    return "\n\n".join(reversed(blocks))  # date-sorted, so not in label order


def stmt_row(q, correct=True, is_abs=False):
    r, srcs = S.good_row(q, correct, is_abs, "candidate"), stmt_sources(q)
    text = stmt_text(srcs)
    n = S.u16(text)
    r["evidence"] = {"text": text, "chars": n, "full_chars": n + sum(s["full_chars"] - s["used_chars"] for s in srcs), "sources": srcs}
    diag = {"selected_occurrences": [s["occurrence"] for s in srcs], "lexical_pool": 80, "lexical_limit": 20, "per_source_raw_chars": 4000,
            "max_chars": 180000, "preferred_speaker": "user", "omitted_occurrences": [7, 101]}
    r["evidence"]["statements"] = diag
    r["statements_diagnostics"] = {**diag, "appended_sources": 2, "rendered_sources": 20}  # the QA row spreads evidence.statements into its diagnostics
    return r


def sfake(calls, correct, tweak=None, after=None, edit=None, cand=stmt_row):
    def run(cmd, cwd, env, stdout, stderr):
        calls.append(cmd)
        flags = dict(zip(cmd[7::2], cmd[8::2]))
        arm = "control" if flags["--evidence"] == "supplemental" else "candidate"
        cases = json.loads(Path(flags["--input"]).read_text())["cases"]
        make = cand if arm == "candidate" else (lambda q, ok, ab: S.good_row(q, ok, ab, "control"))
        rows = [make(c["question_id"], correct(arm, c["question_id"]), c["is_abstention"]) for c in cases]
        if tweak: tweak(len(calls), rows, arm)
        inv = {mod.INVOCATION[f]: (int(v) if v.isdigit() else v) for f, v in flags.items() if f in mod.INVOCATION}
        inv.update(input=flags["--input"], rankings=flags["--rankings"], out=flags["--out"], retrieval="cached")
        report = {"status": "complete", "comparison_valid": True, "invocation": inv, "results": rows, "answer_instructions": {"policy": "minimal", "sha256": "i"},
                  "summary": {"errors": 0, "planned": len(rows), "recorded": len(rows)}, **({"statement_evidence": dict(REPORT)} if arm == "candidate" else {})}
        if arm == "candidate" and "--source-turns" in flags:
            tm = json.loads(Path(flags["--source-turns"]).read_text())
            inv["sourceTurns"] = flags["--source-turns"]
            report["source_turns_manifest"] = {"path": flags["--source-turns"], "sha256": mod.sha(Path(flags["--source-turns"])),
                                               "input_sha256": tm["input_sha256"], "raw_dataset_sha256": tm["raw_dataset_sha256"], "verified_cases": len(rows)}
        if edit: edit(len(calls), report)
        Path(flags["--out"]).write_text(json.dumps(report))
        if after: after(len(calls))
        return 0
    return run


class SEnv(A.Env):
    def __init__(self, tmp):
        super().__init__(tmp)
        self.sprotocol = tmp / mod.STATEMENT_PROTOCOL_NAME
        self.sprotocol.write_text("statement protocol")
        self.turns = tmp / "source-turns.json"
        self.write_turns()

    def write_turns(self, **over):
        """The trusted manifest as the root builder emits it: kind, original input hash, raw dataset hash and an entry per question."""
        m = {"kind": "longmemeval-source-turns-v1", "input_sha256": mod.sha(self.data / mod.INPUT), "raw_dataset_sha256": "d",
             "cases": {q: {"sessions": [{"occurrence": 0, "text_sha256": "t", "speaker_spans": []}]} for q in self.ids}, **over}
        self.turns.write_text(json.dumps(m))

    def run(self, name="out", live=False, runner=None, mode="statements", flag=True, protocol=None, key=True, svpath=None, turns=None):
        prot = protocol or (self.sprotocol if mode == "statements" else self.protocol)
        argv = ["--source-root", str(self.root), "--data-dir", str(self.data), "--node", str(self.node), "--out-dir", str(self.tmp / name),
                "--protocol", str(prot)] + (["--live"] if live else []) + (["--candidate-evidence", mode] if flag else [])
        turns = mode == "statements" if turns is None else turns
        argv += ["--source-turns", str(self.turns)] if turns is True else ["--source-turns", str(turns)] if turns else []
        patches = [mock.patch.object(mod, "BASELINE_SHA", self.base_sha), mock.patch.object(mod, "derive_efforts", A.fake_efforts),
                   mock.patch.dict(os.environ, {"DGX_KEY_FILE": "/unused"} if key else {})]
        if svpath: patches.append(mock.patch.object(mod, "STATEMENT_VALIDATION", svpath))
        with redirect_stderr(io.StringIO()):
            for p in patches: p.start()
            try:
                if not key: os.environ.pop("DGX_KEY_FILE", None)
                return mod.main(argv, runner)
            finally:
                for p in reversed(patches): p.stop()

    def res(self, name="out"): return json.loads((self.tmp / name / "result.json").read_text())


class Rows(unittest.TestCase):
    ids, init = ["q000", "q001"], {"q000": "high", "q001": "low"}

    def problems(self, edit=None, mode="statements"):
        r = stmt_row("q000")
        if edit: edit(r)
        return mod.check_rows([r, stmt_row("q001")], self.ids, set(), "candidate", self.init, mode)

    def bad(self, edit): self.assertTrue(self.problems(edit))

    def test_clean_row_passes_with_unordered_headers_quoted_headers_and_omitted_originals(self):
        r = stmt_row("q000")
        self.assertIn("## Memory 9\n", r["evidence"]["text"])
        self.assertEqual(self.problems(), [])
        self.assertEqual(mod.evidence_problems(r, "candidate", "statements"), [])

    def test_text_caps_and_utf16_lengths(self):
        def grow(r): r["evidence"]["text"] += "x" * 180_000; r["evidence"]["chars"] = S.u16(r["evidence"]["text"])
        self.bad(grow)
        def emoji(r):  # two UTF-16 units per code point: a code-point count must not satisfy chars
            r["evidence"]["text"] += "\U0001F600"
            r["evidence"]["chars"] += 1
        self.bad(emoji)
        self.bad(lambda r: r["evidence"].update(chars=r["evidence"]["chars"] + 1))
        self.bad(lambda r: r["evidence"].update(full_chars=r["evidence"]["full_chars"] + 1))
        self.bad(lambda r: r["evidence"].update(text="short", chars=5, full_chars=5))  # less text than the sources claim to have delivered

    def test_source_counts_and_unique_occurrences(self):
        self.bad(lambda r: r["evidence"]["sources"].pop(0))
        self.bad(lambda r: r["evidence"]["sources"].__setitem__(slice(None), r["evidence"]["sources"][:19]))
        self.bad(lambda r: r["evidence"]["sources"].extend(S.src(f"x{i}", 200 + i) for i in range(20)))  # 42 sources
        self.bad(lambda r: r["evidence"]["sources"][1].update(occurrence=0))

    def test_source_ranges_and_raw_cap_metadata(self):
        def src(i, **kw): return lambda r: r["evidence"]["sources"][i].update(**kw)
        self.bad(src(3, used_chars=51))  # used differs from the range total
        self.bad(src(3, ranges=[{"start": 10, "end": 200}]))  # outside the source
        self.bad(src(3, ranges=[{"start": 30, "end": 60}, {"start": 10, "end": 20}], used_chars=40))  # unordered
        self.bad(src(3, ranges=[{"start": 10, "end": 40}, {"start": 30, "end": 60}], used_chars=60))  # overlapping
        self.bad(src(5, truncated=True))  # whole range but flagged truncated
        self.bad(src(3, truncated=False))
        self.bad(src(7, truncated=False))
        self.bad(src(5, date=None))
        self.bad(src(5, full_chars="100"))

        def over_cap(r):
            s = r["evidence"]["sources"][5]
            s.update(full_chars=4001, used_chars=4001, ranges=[{"start": 0, "end": 4001}])
            r["evidence"]["text"] += "z" * 3901
            r["evidence"]["chars"] += 3901
            r["evidence"]["full_chars"] = r["evidence"]["chars"] + sum(x["full_chars"] - x["used_chars"] for x in r["evidence"]["sources"])
        self.assertTrue(any("exceeds 4000" in p for p in self.problems(over_cap)))

    def test_diagnostics_are_required_and_exact(self):
        d = lambda **kw: (lambda r: (r["statements_diagnostics"].update(**kw), r["evidence"]["statements"].update(**kw)))
        self.bad(lambda r: r.pop("statements_diagnostics"))
        self.bad(lambda r: r["evidence"].pop("statements"))
        self.bad(lambda r: r["evidence"]["statements"].update(max_chars=1))  # the two copies must each be right
        self.bad(d(lexical_pool=79))
        self.bad(d(lexical_pool="80"))
        self.bad(d(lexical_limit=21))
        self.bad(d(per_source_raw_chars=3800))  # additive's cap, not the statement cap
        self.bad(d(max_chars=260000))
        self.bad(d(selected_occurrences=[100, 101]))  # the appended sources alone are not the full identity list
        self.bad(d(selected_occurrences=list(range(21, 0, -1))))
        self.bad(d(omitted_occurrences=[101]))
        self.bad(d(omitted_occurrences=[7, 101, 3]))
        self.assertEqual(self.problems(d(omitted_occurrences=[101, 7])), [])  # order of omissions is free

    def test_wrong_mode_is_blocked_in_both_directions(self):
        add = S.good_row("q000", arm="candidate")
        self.assertTrue(mod.evidence_problems(add, "candidate", "statements"))  # additive row lacks statement diagnostics
        self.assertTrue(mod.evidence_problems(stmt_row("q000"), "candidate"))  # default additive routing rejects a statements row
        self.assertTrue(mod.evidence_problems(stmt_row("q000"), "candidate", "additive"))
        self.bad(lambda r: r["evidence"].update(additive={"base_chars": 1, "extra_chars": 0}))
        self.bad(lambda r: r.update(additive_diagnostics={}))
        ctl = S.good_row("q000")
        self.assertEqual(mod.evidence_problems(ctl, "control"), [])
        self.assertEqual(mod.evidence_problems(ctl, "control", "statements"), [])
        ctl["statements_diagnostics"] = {}
        self.assertTrue(mod.evidence_problems(ctl, "control", "statements"))
        self.assertEqual(mod.evidence_problems(ctl, "control"), [])  # additive mode is untouched

    def test_report_provenance_and_invocation_follow_the_mode(self):
        self.assertEqual(mod.arm_flags("candidate")["--evidence"], "additive")
        self.assertEqual(mod.arm_flags("candidate", "statements")["--evidence"], "statements")
        self.assertEqual(mod.arm_flags("control", "statements")["--evidence"], "supplemental")
        self.assertEqual(SV.report_problems({"statement_evidence": dict(REPORT)}, "candidate"), [])
        self.assertTrue(SV.report_problems({}, "candidate"))
        self.assertTrue(SV.report_problems({"statement_evidence": {**REPORT, "lexical_pool": 40}}, "candidate"))
        self.assertTrue(SV.report_problems({"statement_evidence": {**REPORT, "reserve_speaker_units": 1}}, "candidate"))
        self.assertTrue(SV.report_problems({"statement_evidence": dict(REPORT)}, "control"))
        self.assertTrue(SV.report_problems({"statement_evidence": dict(REPORT), "additive_evidence": {}}, "candidate"))


class Compare(unittest.TestCase):
    ids = [f"q{i:03d}" for i in range(6)]
    abs_ids = {"q000", "q001"}
    init = {q: S.effort_of(q) for q in ids}

    def rows(self, correct, arm):
        return {q: (stmt_row if arm == "candidate" else S.good_row)(q, q in correct, q in self.abs_ids, *(() if arm == "candidate" else (arm,))) for q in self.ids}

    def compare(self, control, candidate, instr=INSTR):
        c = self.rows(control, "control") if isinstance(control, set) else control
        k = self.rows(candidate, "candidate") if isinstance(candidate, set) else candidate
        return mod.compare(self.ids, c, k, self.abs_ids, self.init, instr, "statements")

    def test_gate_passes_with_identity_parity_though_ranges_and_text_differ(self):
        control = self.rows({"q000", "q005"}, "control")
        cand = self.rows({"q000", "q002", "q003", "q004"}, "candidate")
        self.assertNotEqual(control["q002"]["evidence"]["sources"][3]["ranges"], cand["q002"]["evidence"]["sources"][3]["ranges"])
        self.assertFalse(cand["q002"]["evidence"]["text"].startswith(control["q002"]["evidence"]["text"]))
        r = self.compare(control, cand)
        self.assertTrue(r["advancement_screen_passed"])
        self.assertEqual(list(r["checks"]), ["all_rows_present_error_free", "net_gain_at_least_2", "no_abstention_pair_loss", "source_identity_parity", "answer_instructions_match"])
        self.assertEqual((r["gains"], r["losses"], r["net"], r["source_identity_parity_failures"]), (["q002", "q003", "q004"], ["q005"], 2, {}))
        self.assertNotIn("prefix_or_source_parity_failures", r)
        self.assertEqual(r["source_review"], {"required": True, "status": "pending", "gains": ["q002", "q003", "q004"], "losses": ["q005"]})

    def test_additive_compare_is_unchanged_by_default(self):
        ids, abs_ids = ["q000", "q003"], {"q000"}
        c = {q: S.good_row(q, False, q in abs_ids, "control") for q in ids}
        k = {q: S.good_row(q, True, q in abs_ids, "candidate") for q in ids}
        r = mod.compare(ids, c, k, abs_ids, {q: S.effort_of(q) for q in ids}, INSTR)
        self.assertIn("base_prefix_and_source_parity", r["checks"])
        self.assertIn("prefix_or_source_parity_failures", r)

    def test_numeric_gate(self):
        k = {"q000", "q003", "q004"}
        self.assertFalse(self.compare({"q000"}, {"q000", "q003"})["checks"]["net_gain_at_least_2"])
        self.assertTrue(self.compare({"q000"}, k)["advancement_screen_passed"])
        r = self.compare({"q000"}, {"q001", "q003", "q004", "q005"})
        self.assertEqual(r["abstention_losses"], ["q000"])
        self.assertFalse(r["advancement_screen_passed"])
        self.assertFalse(self.compare({"q000"}, k, {"control": {"i"}, "candidate": {"j"}})["advancement_screen_passed"])
        self.assertFalse(self.compare({"q000"}, k, None)["checks"]["answer_instructions_match"])

    def test_any_first_twenty_identity_drift_fails_parity(self):
        edits = {"id": lambda s: s.update(id="other"), "occurrence": lambda s: s.update(occurrence=999),
                 "date": lambda s: s.update(date="2030-01-01"), "full_chars": lambda s: s.update(full_chars=s["full_chars"] + 1)}
        for name, edit in edits.items():
            cand = self.rows({"q000", "q003", "q004"}, "candidate")
            edit(cand["q002"]["evidence"]["sources"][5])
            r = self.compare({"q000"}, cand)
            self.assertEqual(list(r["source_identity_parity_failures"]), ["q002"], name)
            self.assertFalse(r["advancement_screen_passed"], name)
        cand = self.rows({"q000", "q003", "q004"}, "candidate")
        cand["q002"]["evidence"]["sources"][0], cand["q002"]["evidence"]["sources"][1] = cand["q002"]["evidence"]["sources"][1], cand["q002"]["evidence"]["sources"][0]
        self.assertFalse(self.compare({"q000"}, cand)["checks"]["source_identity_parity"])  # order is part of the identity

    def test_unclean_candidate_rows_block_pass(self):
        cand = self.rows({"q000", "q003", "q004"}, "candidate")
        cand["q005"]["statements_diagnostics"]["max_chars"] = 1
        r = self.compare({"q000"}, cand)
        self.assertFalse(r["checks"]["all_rows_present_error_free"] or r["advancement_screen_passed"])


class Supervisor(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(dir="/tmp", prefix="recall-statement-test-")
        self.addCleanup(self.td.cleanup)
        self.env = SEnv(Path(self.td.name))
        self.out = self.env.tmp / "out"

    def test_additive_stays_the_default_and_writes_nothing_new(self):
        self.assertEqual(self.env.run(mode="additive", flag=False), 0)
        st = self.env.state()
        self.assertNotIn("candidate_evidence", st)
        self.assertNotIn("statement_validation", json.loads((self.out / "inventory.json").read_text()))
        self.assertNotIn("statement_validation", st["hashes"])
        self.assertNotIn("candidate_evidence", json.loads((self.out / "selection.json").read_text()))
        self.assertEqual({c[c.index("--evidence") + 1] for c in st["planned_commands"]}, {"supplemental", "additive"})
        self.assertEqual(self.env.run("explicit", mode="additive"), 0)
        flags = lambda name: [c[c.index("--evidence") + 1] for c in self.env.state(name)["planned_commands"]]
        self.assertEqual(flags("explicit"), flags("out"))

    def test_protocol_basename_guard_in_both_modes(self):
        with self.assertRaises(SystemExit): self.env.run(protocol=self.env.protocol)  # statements need their own protocol
        with self.assertRaises(SystemExit): self.env.run(mode="additive", protocol=self.env.sprotocol)
        with self.assertRaises(SystemExit): self.env.run(mode="additive", flag=False, protocol=self.env.sprotocol)
        self.env.sprotocol.unlink()
        with self.assertRaises(SystemExit): self.env.run()
        with self.assertRaises(SystemExit): self.env.run(mode="bogus")
        self.assertFalse(self.out.exists())

    def test_prepare_plans_68_statement_commands_over_the_same_frozen_cohort(self):
        calls = []
        self.assertEqual(self.env.run("add", mode="additive"), 0)
        self.assertEqual(self.env.run(runner=sfake(calls, lambda *a: True)), 0)
        self.assertEqual(calls, [])
        st, ad = self.env.state(), self.env.state("add")
        self.assertEqual((st["status"], st["mode"], st["candidate_evidence"], len(st["planned_commands"])), ("prepared", "prepare", "statements", 68))
        self.assertEqual([c[c.index("--evidence") + 1] for c in st["planned_commands"][:4]], ["supplemental", "statements", "statements", "supplemental"])
        for c in st["planned_commands"]:
            flags = dict(zip(c[7::2], c[8::2]))
            self.assertEqual({k: flags[k] for k in ("--reasoning-effort", "--max-output-tokens", "--context-chars", "--top-k", "--concurrency")},
                             {"--reasoning-effort": "adaptive", "--max-output-tokens": "16384", "--context-chars": "180000", "--top-k": "20", "--concurrency": "3"})
        for key in ("selected_question_ids", "abstention_ids", "initial_effort", "schedule", "block_sha256", "cohort_size"): self.assertEqual(st[key], ad[key], key)
        self.assertEqual(st["selected_question_ids"], self.env.ids)
        sel, asel = (json.loads((self.env.tmp / n / "selection.json").read_text()) for n in ("out", "add"))
        self.assertEqual({k: v for k, v in sel.items() if k not in ("recorded_at", "candidate_evidence")}, {k: v for k, v in asel.items() if k != "recorded_at"})
        self.assertEqual(sel["candidate_evidence"], "statements")
        inv = json.loads((self.out / "inventory.json").read_text())
        self.assertEqual(inv["statement_validation"], mod.sha(mod.STATEMENT_VALIDATION))
        self.assertEqual(st["hashes"]["statement_validation"], inv["statement_validation"])
        self.assertEqual(inv["protocol"], mod.sha(self.env.sprotocol))
        self.assertIn("statement-evidence", st["claim"])
        self.assertIn("not a full500 score", st["claim"])

    def test_live_pass_reports_pending_source_review_with_intentionally_different_ranges(self):
        gain, calls = set(self.env.sel_ans[:3]), []
        self.assertEqual(self.env.run(live=True, runner=sfake(calls, lambda arm, q: arm == "candidate" or q not in gain)), 0)
        self.assertEqual(len(calls), 68)
        res = self.env.res()
        self.assertEqual((res["status"], res["net"], sorted(res["gains"]), res["strata"]), ("pending_source_review", 3, sorted(gain), {"abstention": 30, "answerable": 70}))
        self.assertTrue(res["advancement_screen_passed"] and res["checks"]["source_identity_parity"])
        self.assertNotIn("base_prefix_and_source_parity", res["checks"])
        self.assertEqual(res["source_review"]["status"], "pending")
        self.assertIn("statement-evidence", res["claim"])
        self.assertEqual(res["usage"]["candidate"]["physical_calls"]["answer_call"], 100)
        self.assertEqual(self.env.state()["status"], "pending_source_review")

    def test_live_screen_failures_are_reported(self):
        lost, gain = self.env.sel_abs[0], set(self.env.sel_ans[:3])
        self.assertEqual(self.env.run(live=True, runner=sfake([], lambda arm, q: q != lost if arm == "candidate" else q not in gain)), 0)
        res = self.env.res()
        self.assertEqual((res["abstention_losses"], res["status"], res["net"]), ([lost], "screen_not_passed", 2))
        def tweak(n, rows, arm):
            if arm == "candidate": rows[0]["evidence"]["sources"][0]["id"] = "forged"
        self.assertEqual(self.env.run("drift", live=True, runner=sfake([], lambda arm, q: arm == "candidate" or q not in gain, tweak=tweak)), 0)
        res = self.env.res("drift")
        self.assertEqual((res["status"], res["checks"]["source_identity_parity"]), ("screen_not_passed", False))

    def test_live_stops_on_cap_raw_metadata_or_diagnostic_errors(self):
        edits = (lambda r: r["evidence"]["sources"][5].update(used_chars=4001),
                 lambda r: r["statements_diagnostics"].update(lexical_pool=79),
                 lambda r: r["evidence"].update(chars=r["evidence"]["chars"] + 1),
                 lambda r: r["statements_diagnostics"].update(omitted_occurrences=[]))
        for i, f in enumerate(edits):
            calls = []
            tweak = lambda n, rows, arm, f=f: f(rows[0]) if arm == "candidate" else None
            self.assertEqual(self.env.run(f"bad{i}", live=True, runner=sfake(calls, lambda *a: True, tweak=tweak)), 6, i)
            self.assertEqual((len(calls), self.env.state(f"bad{i}")["status"]), (2, "stage_invalid"))  # control passes, the first candidate stage is rejected
            self.assertFalse((self.env.tmp / f"bad{i}" / "result.json").exists())

    def test_live_blocks_wrong_mode_rows_report_and_invocation(self):
        calls = []
        self.assertEqual(self.env.run(live=True, runner=sfake(calls, lambda *a: True, cand=lambda q, c, a: S.good_row(q, c, a, "candidate"))), 6)
        self.assertEqual(len(calls), 2)
        calls = []
        edit = lambda n, rep: rep.pop("statement_evidence") if n == 2 else None
        self.assertEqual(self.env.run("noreport", live=True, runner=sfake(calls, lambda *a: True, edit=edit)), 6)
        self.assertIn("statement_evidence", " ".join(self.env.state("noreport")["stages"]["1"]["problems"]))
        edit = lambda n, rep: rep["invocation"].update(evidence="additive") if n == 2 else None
        self.assertEqual(self.env.run("inv", live=True, runner=sfake([], lambda *a: True, edit=edit)), 6)
        self.assertIn("invocation evidence", " ".join(self.env.state("inv")["stages"]["1"]["problems"]))
        tweak = lambda n, rows, arm: rows[0].update(statements_diagnostics={}) if arm == "control" else None
        self.assertEqual(self.env.run("ctl", live=True, runner=sfake([], lambda *a: True, tweak=tweak)), 6)

    def test_fake_live_statuses_for_missing_key_missing_report_and_unchanged_inventory(self):
        calls = []
        self.assertEqual(self.env.run(live=True, key=False, runner=sfake(calls, lambda *a: True)), 7)
        self.assertEqual((self.env.state()["status"], calls), ("dgx_key_file_unset", []))
        self.assertEqual(self.env.run("noreport", live=True, runner=lambda cmd, cwd, env, so, se: 1), 5)
        self.assertEqual(self.env.state("noreport")["status"], "stage_no_report")
        copy = self.env.tmp / "sv-copy.py"
        shutil.copy(mod.STATEMENT_VALIDATION, copy)
        after = lambda n: copy.write_text(copy.read_text() + "\n# edited\n") if n == 1 else None
        calls = []
        self.assertEqual(self.env.run("pin", live=True, svpath=copy, runner=sfake(calls, lambda *a: True, after=after)), 3)
        self.assertEqual((len(calls), self.env.state("pin")["status"]), (1, "inventory_mismatch"))
        mod.statement_validation.cache_clear()

    def test_missing_statement_validator_fails_closed_before_output(self):
        mod.statement_validation.cache_clear()
        self.addCleanup(mod.statement_validation.cache_clear)
        self.assertEqual(self.env.run(svpath=self.env.tmp / "absent.py"), 2)
        self.assertEqual(self.env.state()["status"], "error")
        self.assertFalse((self.out / "selection.json").exists())


class SourceTurns(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(dir="/tmp", prefix="recall-statement-turns-test-")
        self.addCleanup(self.td.cleanup)
        self.env = SEnv(Path(self.td.name))
        self.out = self.env.tmp / "out"

    def stage_problems(self, name, edit, code=6, stage="1"):
        self.assertEqual(self.env.run(name, live=True, runner=sfake([], lambda *a: True, edit=edit)), code)
        return " ".join(self.env.state(name)["stages"][stage]["problems"])

    def test_flag_is_required_for_statements_and_rejected_for_additive(self):
        with self.assertRaises(SystemExit): self.env.run(turns=False)
        with self.assertRaises(SystemExit): self.env.run(mode="additive", turns=True)
        with self.assertRaises(SystemExit): self.env.run(mode="additive", flag=False, turns=True)
        with self.assertRaises(SystemExit): self.env.run(turns=self.env.tmp / "absent.json")
        self.assertFalse(self.out.exists())
        self.assertEqual(self.env.run("add", mode="additive"), 0)  # default unchanged: no flag, no new state
        add = self.env.state("add")
        self.assertNotIn("source_turns", add)
        self.assertNotIn("source_turns", add["hashes"])
        self.assertFalse(any("--source-turns" in c for c in add["planned_commands"]))

    def test_prepare_pins_the_manifest_and_only_the_candidate_receives_it(self):
        self.assertEqual(self.env.run(), 0)
        st, inv = self.env.state(), json.loads((self.out / "inventory.json").read_text())
        for c in st["planned_commands"]:
            cand = c[c.index("--evidence") + 1] == "statements"
            self.assertEqual("--source-turns" in c, cand)
            if cand: self.assertEqual(c[c.index("--source-turns") + 1], str(self.env.turns))
        self.assertEqual(inv["source_turns"], mod.sha(self.env.turns))
        self.assertEqual(st["hashes"]["source_turns"], inv["source_turns"])
        self.assertEqual(st["source_turns"], {"path": str(self.env.turns), "sha256": mod.sha(self.env.turns),
                                              "input_sha256": mod.sha(self.env.data / mod.INPUT), "raw_dataset_sha256": "d"})
        self.assertEqual(st["selected_question_ids"], self.env.ids)

    def test_manifest_preflight_fails_closed_before_selection_is_written(self):
        mut = {"kind": dict(kind="other"), "input": dict(input_sha256="0" * 64), "raw": dict(raw_dataset_sha256="x"),
               "missing": dict(cases={q: {"s": 1} for q in self.env.ids[1:]}), "empty": dict(cases={**{q: {"s": 1} for q in self.env.ids}, self.env.ids[0]: {}}),
               "nocases": dict(cases=None)}
        for i, (name, over) in enumerate(mut.items()):
            self.env.write_turns(**over)
            self.assertEqual(self.env.run(f"p{i}"), 2, name)
            self.assertEqual(self.env.state(f"p{i}")["status"], "source_turns_invalid", name)
            self.assertFalse((self.env.tmp / f"p{i}" / "selection.json").exists(), name)
        self.env.turns.write_text("{not json")
        self.assertEqual(self.env.run("bad"), 2)
        self.assertEqual(self.env.state("bad")["status"], "source_turns_unreadable")
        self.env.write_turns(cases=[{"question_id": q, "sessions": [1]} for q in self.env.ids])  # list form is accepted
        self.assertEqual(self.env.run("list"), 0)

    def test_live_candidate_report_must_carry_matching_provenance(self):
        cases = {"path": lambda r: r["invocation"].update(sourceTurns="/elsewhere.json"),
                 "invocation": lambda r: r["invocation"].pop("sourceTurns"),
                 "manifest": lambda r: r.pop("source_turns_manifest"),
                 "sha256": lambda r: r["source_turns_manifest"].update(sha256="0" * 64),
                 "input": lambda r: r["source_turns_manifest"].update(input_sha256="1" * 64),
                 "raw": lambda r: r["source_turns_manifest"].update(raw_dataset_sha256="x"),
                 "verified": lambda r: r["source_turns_manifest"].update(verified_cases=r["source_turns_manifest"]["verified_cases"] + 1),
                 "verified_type": lambda r: r["source_turns_manifest"].update(verified_cases=str(r["source_turns_manifest"]["verified_cases"])),
                 "path_field": lambda r: r["source_turns_manifest"].update(path="/elsewhere.json")}
        for name, edit in cases.items():
            msg = self.stage_problems(name, lambda n, rep, edit=edit: edit(rep) if n == 2 else None)
            self.assertTrue("source_turns" in msg or "sourceTurns" in msg, (name, msg))
            self.assertFalse((self.env.tmp / name / "result.json").exists())

    def test_control_must_not_receive_or_report_source_turns(self):
        msg = self.stage_problems("c1", lambda n, rep: rep["invocation"].update(sourceTurns=str(self.env.turns)) if n == 1 else None, stage="0")
        self.assertIn("control invocation carries sourceTurns", msg)
        msg = self.stage_problems("c2", lambda n, rep: rep.update(source_turns_manifest={}) if n == 1 else None, stage="0")
        self.assertIn("control report carries source_turns_manifest", msg)

    def test_turns_provenance_is_optional_for_additive_checks_and_required_for_statements(self):
        ids, expect = ["q000"], {"input": "i", "rankings": "r", "out": "o"}
        self.assertTrue(any("source turns expectation missing" in p for p in SV.turns_problems({"invocation": {}}, "candidate", None, 1)))
        self.assertEqual(SV.turns_problems({"invocation": {}}, "control", None, 1), [])
        t = {"path": "/p", "sha256": "a", "input_sha256": "b", "raw_dataset_sha256": "c"}
        rep = {"invocation": {"sourceTurns": "/p"}, "source_turns_manifest": {**t, "verified_cases": 1}}
        self.assertEqual(SV.turns_problems(rep, "candidate", t, 1), [])
        self.assertTrue(SV.turns_problems(rep, "candidate", t, 2))

    def test_source_metadata_schema_rejects_speaker_spans(self):
        r = stmt_row("q000")
        r["evidence"]["sources"][2]["speaker_spans"] = [{"speaker": "user", "start": 0, "end": 4}]
        self.assertTrue(any("keys differ" in p for p in mod.evidence_problems(r, "candidate", "statements")))

    def test_turns_file_change_during_the_run_stops_it(self):
        calls = []
        after = lambda n: self.env.turns.write_text(self.env.turns.read_text() + " ") if n == 1 else None
        self.assertEqual(self.env.run(live=True, runner=sfake(calls, lambda *a: True, after=after)), 3)
        self.assertEqual((len(calls), self.env.state()["status"]), (1, "inventory_mismatch"))

    def test_live_pass_with_provenance(self):
        gain = set(self.env.sel_ans[:3])
        self.assertEqual(self.env.run(live=True, runner=sfake([], lambda arm, q: arm == "candidate" or q not in gain)), 0)
        self.assertEqual(self.env.res()["status"], "pending_source_review")


if __name__ == "__main__":
    unittest.main()
