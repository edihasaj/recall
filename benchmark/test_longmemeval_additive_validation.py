"""Offline tests for longmemeval_additive_validation.py: evidence bounds and usage accounting."""
import importlib.util, sys, unittest
from pathlib import Path

sys.dont_write_bytecode = True


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


V = load("additive_validation", "longmemeval_additive_validation.py")
S = load("additive_support", "longmemeval_additive_test_support.py")
HDR = "\n\n## Lexical Memory 21\n"


def fix(ev):
    """Recompute the derived counts so a test changes only the thing it means to change."""
    ev["chars"] = S.u16(ev["text"])
    ev["full_chars"] = ev["chars"] + sum(s["full_chars"] - s["used_chars"] for s in ev["sources"])
    if ev.get("additive"): ev["additive"]["extra_chars"] = ev["chars"] - ev["additive"]["base_chars"]


def problems(arm, mutate=None, refix=True):
    row = S.good_row("q001", arm=arm)
    if mutate:
        mutate(row["evidence"])
        if refix: fix(row["evidence"])
    return V.evidence_problems(row, arm)


def has(ps, text): return any(text in p for p in ps)


def set_extra(ev, body): ev["text"] = ev["text"][:ev["additive"]["base_chars"]] + HDR + body


def omit(ev):
    ev["text"] = ev["text"][:ev["additive"]["base_chars"]]
    ev["sources"][20] = dict(S.src("x", 100, 50), used_chars=0, truncated=True, ranges=[])
    ev["additive"].update(included_ranks=[], omitted=[{"source_rank": 21, "reason": "budget"}])


class Bounds(unittest.TestCase):
    def test_valid_rows_pass_including_omitted_and_non_bmp_extras(self):
        self.assertEqual(problems("control"), [])
        self.assertEqual(problems("candidate"), [])
        self.assertEqual(problems("candidate", omit), [])
        self.assertEqual(problems("candidate", lambda ev: set_extra(ev, "\U0001F600" * 25)), [])  # 25 code points, 50 UTF-16 units

    def test_non_bmp_chars_counted_as_code_points_are_rejected(self):
        def f(ev):
            set_extra(ev, "\U0001F600" * 25)
            fix(ev)
            ev["chars"] = len(ev["text"])
        self.assertTrue(has(problems("candidate", f, refix=False), "evidence.chars"))

    def test_oversized_total_text(self):
        self.assertTrue(has(problems("control", lambda ev: ev.update(text="x" * 180_001)), "over 180000"))
        self.assertTrue(has(problems("candidate", lambda ev: set_extra(ev, "y" * 260_001)), "over 260000"))
        self.assertTrue(has(problems("candidate", lambda ev: set_extra(ev, "y" * 80_001)), "extra_chars"))

    def test_source_counts(self):
        self.assertTrue(has(problems("control", lambda ev: ev["sources"].append(S.src("x", 99))), "21 sources"))
        self.assertTrue(has(problems("control", lambda ev: ev["sources"].pop()), "19 sources"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["sources"].__delitem__(slice(19, None))), "19 sources"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["sources"].extend(S.src(f"x{i}", 200 + i) for i in range(20))), "41 sources"))

    def test_forged_counts(self):
        self.assertTrue(has(problems("candidate", lambda ev: ev["additive"].update(extra_chars=ev["additive"]["extra_chars"] + 1), refix=False), "differs from UTF-16 text length"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["additive"].update(base_chars=ev["additive"]["base_chars"] - 1), refix=False), "differs from UTF-16 text length"))
        self.assertTrue(has(problems("candidate", lambda ev: ev.update(chars=ev["chars"] + 1), refix=False), "evidence.chars"))
        self.assertTrue(has(problems("control", lambda ev: ev.pop("chars"), refix=False), "evidence.chars"))
        self.assertTrue(has(problems("control", lambda ev: ev.update(full_chars=ev["full_chars"] + 5), refix=False), "full_chars"))
        self.assertTrue(has(problems("control", lambda ev: ev.update(additive={"base_chars": 1, "extra_chars": 0}), refix=False), "carries additive"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["additive"].update(base_chars="5"), refix=False), "invalid"))

    def test_extra_source_range_accounting(self):
        def extra(**kw): return lambda ev: ev["sources"][20].update(**kw)
        self.assertTrue(has(problems("candidate", extra(used_chars=3900, full_chars=3900, ranges=[{"start": 0, "end": 3900}])), "exceeds 3800"))  # raw overflow
        self.assertTrue(has(problems("candidate", extra(ranges=[{"start": 0, "end": 30}, {"start": 20, "end": 50}])), "ranges invalid"))  # overlap
        self.assertTrue(has(problems("candidate", extra(ranges=[{"start": 30, "end": 50}, {"start": 0, "end": 20}])), "ranges invalid"))  # unordered
        self.assertTrue(has(problems("candidate", extra(ranges=[{"start": 0, "end": 60}])), "ranges invalid"))  # outside the source
        self.assertTrue(has(problems("candidate", extra(ranges=[{"start": 5, "end": 5}])), "ranges invalid"))  # empty range
        self.assertTrue(has(problems("candidate", extra(used_chars=40)), "differs from range total"))
        self.assertTrue(has(problems("candidate", extra(truncated=True)), "truncated flag"))
        self.assertTrue(has(problems("candidate", extra(used_chars=True)), "full_chars/used_chars invalid"))
        self.assertTrue(has(problems("candidate", extra(used_chars=50.0)), "full_chars/used_chars invalid"))
        self.assertTrue(has(problems("candidate", extra(used_chars=60)), "full_chars/used_chars invalid"))

    def test_framing_floor_and_actual_block_cap(self):
        many = [{"start": i * 20, "end": i * 20 + 7} for i in range(400)]  # 2800 delivered characters, 399 gaps, ellipsis lines
        f = lambda ev: ev["sources"][20].update(full_chars=8000, used_chars=2800, truncated=True, ranges=many)
        self.assertTrue(has(problems("candidate", f), "framing needs at least"))
        self.assertTrue(has(problems("candidate", lambda ev: set_extra(ev, "y" * 4100)), "extra block rank 21"))

    def test_included_omitted_and_selected_bookkeeping(self):
        self.assertTrue(has(problems("candidate", lambda ev: ev["additive"].update(included_ranks=[])), "included_ranks"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["additive"].update(selected_occurrences=[999])), "selected_occurrences"))
        self.assertTrue(has(problems("candidate", lambda ev: (omit(ev), ev["additive"].update(included_ranks=[21]))), "included_ranks"))
        self.assertTrue(has(problems("candidate", lambda ev: (omit(ev), ev["additive"]["omitted"][0].update(reason="x"))), "malformed"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["additive"].update(omitted=[{"source_rank": 21, "reason": "budget"}])), "omitted ranks"))
        self.assertTrue(has(problems("candidate", lambda ev: ev.update(text=ev["text"].replace("Lexical Memory 21", "Lexical Memory 22"))), "block header"))
        self.assertTrue(has(problems("candidate", lambda ev: ev["sources"][20].update(occurrence=-1)), "invalid"))


class QuotedHeaders(unittest.TestCase):
    """A source body may quote a block header; the real boundaries are found by a complete partition search."""
    FAKE = "user: Quoted header follows.\n\n## Lexical Memory 22\n" + "x" * 3000

    def two(self, body21, real22="## Lexical Memory 22\n", used22=3006):
        def f(ev):
            b = ev["additive"]["base_chars"]
            ev["text"] = ev["text"][:b] + HDR + body21 + "\n\n" + real22 + "user: " + "y" * 3000
            ev["sources"][20] = S.src("a", 100, S.u16(body21))
            ev["sources"].append(S.src("b", 101, used22))
            ev["additive"].update(selected_occurrences=[100, 101], included_ranks=[21, 22])
        return f

    def test_quoted_lookalike_header_does_not_cause_a_false_overflow(self):
        self.assertEqual(S.u16(self.FAKE), 3051)
        self.assertEqual(problems("candidate", self.two(self.FAKE)), [])

    def test_lookalike_with_non_ascii_body_and_three_blocks(self):
        body = "user: \U0001F600 quoted\n\n## Lexical Memory 22\n\n\n## Lexical Memory 23\n" + "z" * 1500
        def f(ev):
            b = ev["additive"]["base_chars"]
            blocks = [(21, body), (22, "user: " + "y" * 900), (23, "user: " + "w" * 900)]
            ev["text"] = ev["text"][:b] + "".join(f"\n\n## Lexical Memory {r}\n{t}" for r, t in blocks)
            ev["sources"][20] = S.src("a", 100, S.u16(body))
            ev["sources"] += [S.src("b", 101, 906), S.src("c", 102, 906)]
            ev["additive"].update(selected_occurrences=[100, 101, 102], included_ranks=[21, 22, 23])
        self.assertEqual(problems("candidate", f), [])

    def test_missing_real_header_still_fails_when_no_partition_exists(self):
        ps = problems("candidate", self.two(self.FAKE, real22=""))
        self.assertTrue(ps)
        self.assertTrue(has(ps, "extra block rank 21") or has(ps, "block header") or has(ps, "partition"))

    def test_false_metadata_still_fails_caps_and_ranges(self):
        f = self.two(self.FAKE)
        def big(ev):
            f(ev)
            ev["sources"][20].update(used_chars=3900, full_chars=3900, ranges=[{"start": 0, "end": 3900}])
        self.assertTrue(has(problems("candidate", big), "exceeds 3800"))
        def overlap(ev):
            f(ev)
            ev["sources"][21]["ranges"] = [{"start": 0, "end": 30}, {"start": 20, "end": 3006}]
        self.assertTrue(has(problems("candidate", overlap), "ranges invalid"))

    def test_block_under_its_floor_fails(self):
        def f(ev):
            self.two(self.FAKE)(ev)
            ev["sources"][21].update(full_chars=3500, used_chars=3500, ranges=[{"start": 0, "end": 3500}])  # claims more than the 3006 delivered
        self.assertTrue(has(problems("candidate", f), "under its framing floor"))


class UsageAccounting(unittest.TestCase):
    def row(self, **calls):
        r = S.good_row("q000", arm="candidate")
        r.update(calls)
        return r

    def test_clean_single_attempt_calls_are_complete(self):
        u = V.usage([self.row()])
        self.assertTrue(u["usage_complete"])
        self.assertEqual((u["prior_http_attempts_unknown_usage"], u["prior_attempts_unknown"], u["unknown_usage"]), ({}, [], []))
        self.assertTrue(u["observed_totals_are_lower_bounds"])

    def test_three_attempts_with_known_final_usage_leave_two_prior_attempts_unknown(self):
        u = V.usage([self.row(answer_call=S.call("high", prompt="p", adaptive=True, attempts=3))])
        self.assertEqual(u["prior_http_attempts_unknown_usage"], {"answer_call": 2})
        self.assertEqual(u["prior_attempts_unknown"], [{"question_id": "q000", "call": "answer_call", "prior_attempts": 2, "final_usage_known": True}])
        self.assertEqual(u["unknown_usage_calls"], {})  # the final attempt was metered
        self.assertEqual(u["tokens"]["answer_call.input"], 10)  # observed total is a lower bound, not the whole bill
        self.assertFalse(u["usage_complete"])

    def test_unknown_final_usage_is_reported_separately(self):
        u = V.usage([self.row(judge_call=S.call("none", 4096, "j", usage=False))])
        self.assertEqual(u["unknown_usage_calls"], {"judge_call": 1})
        self.assertEqual(u["unknown_usage"], [{"question_id": "q000", "call": "judge_call", "error": None}])
        self.assertEqual(u["prior_http_attempts_unknown_usage"], {})
        self.assertEqual(u["tokens"]["total.input"], 20)  # unknown call adds nothing, never a guessed zero-as-known
        self.assertFalse(u["usage_complete"])

    def test_unknown_final_usage_with_retries_counts_both(self):
        u = V.usage([self.row(premise_call=S.call("low", 4096, "x", usage=False, attempts=2))])
        self.assertEqual((u["unknown_usage_calls"], u["prior_http_attempts_unknown_usage"]), ({"premise_call": 1}, {"premise_call": 1}))

    def test_nested_transport_failures_count_their_own_attempts(self):
        failed = S.call("high", error="request_failed", usage=False, attempts=2, adaptive=True)
        u = V.usage([self.row(answer_call=S.call("high", adaptive=True, attempts=2, transport_failures=[failed]))])
        self.assertEqual(u["prior_http_attempts_unknown_usage"], {"answer_call": 2})
        self.assertEqual(u["transport_failures"]["answer_call"], 1)


if __name__ == "__main__":
    unittest.main()
