"""Evidence bounds validation and usage accounting for the additive-evidence trial supervisor.

Loaded by run-longmemeval-additive-trial.py without writing bytecode. Offsets and lengths are
JavaScript UTF-16 code units, as recorded by the TypeScript producer. Framing checks are lower
bounds from recorded ranges (label plus ellipses) and an upper bound on the actual extracted block;
the observation-date line is never reconstructed.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import Counter
from typing import Any

CONTROL_CAP, CANDIDATE_CAP, BASE_CAP, EXTRA_CAP = 180_000, 260_000, 180_000, 80_000
FRAMED_CAP, RAW_CAP, ORIGINAL, MAX_SOURCES = 4_000, 3_800, 20, 40
HEADER = "## Lexical Memory "
OMIT_REASONS = {"no_complete_unit", "budget"}


def u16(s: str) -> int: return len(s.encode("utf-16-le", "surrogatepass")) // 2
def nat(v: Any) -> bool: return type(v) is int and v >= 0


def source_problems(s: Any, label: str, extra: bool) -> list[str]:
    """Structure of one source's metadata; extras additionally must account exactly for their delivered ranges."""
    if not isinstance(s, dict): return [f"{label} metadata is not an object"]
    out: list[str] = []
    full, used, rs = s.get("full_chars"), s.get("used_chars"), s.get("ranges")
    if not (isinstance(s.get("id"), str) and nat(s.get("occurrence"))): out.append(f"{label} id or occurrence invalid")
    if not (nat(full) and nat(used) and used <= full): return out + [f"{label} full_chars/used_chars invalid"]
    if not isinstance(s.get("truncated"), bool): out.append(f"{label} truncated is not boolean")
    if not isinstance(rs, list): return out + [f"{label} ranges is not a list"]
    prev = total = 0
    for r in rs:
        if not (isinstance(r, dict) and nat(r.get("start")) and nat(r.get("end")) and r["start"] < r["end"] <= full) or r["start"] < prev:
            return out + [f"{label} ranges invalid, unordered, overlapping or outside the source"]
        prev, total = r["end"], total + r["end"] - r["start"]
    if extra:
        if used != total: out.append(f"{label} used_chars {used} differs from range total {total}")
        if used > RAW_CAP: out.append(f"{label} used_chars {used} exceeds {RAW_CAP}")
        whole = len(rs) == 1 and rs[0]["start"] == 0 and rs[0]["end"] == full
        if isinstance(s.get("truncated"), bool) and s["truncated"] is not ((not whole) if rs else full > 0):
            out.append(f"{label} truncated flag disagrees with its ranges")
    return out


def framing_floor(rank: int, s: dict) -> int:
    """Least possible framed length: label line, delivered characters and the renderer's ellipsis lines."""
    rs = s["ranges"]
    return u16(f"{HEADER}{rank}\n") + s["used_chars"] + (2 if rs[0]["start"] > 0 else 0) + 3 * (len(rs) - 1) + (2 if rs[-1]["end"] < s["full_chars"] else 0)


def find_marks(b: bytes, rank: int) -> list[int]:
    """UTF-16 unit offsets of every (aligned) occurrence of the rank's block marker, quoted lookalikes included."""
    m = f"\n\n{HEADER}{rank}\n".encode("utf-16-le")
    out, i = [], b.find(m)
    while i >= 0:
        if i % 2 == 0: out.append(i // 2)
        i = b.find(m, i + 1)
    return out


def partition(tb: bytes, inc: list[int], floors: list[int]) -> list[int] | None:
    """Block start offsets for a complete partition of the extra text, or None. Body text can quote a header, so every
    marker assignment is considered: block 0 starts at 0, each block (marker start + 2 .. next marker start, or the end)
    is between its framing floor and the framed cap, and the last block runs to the end. DFS with failure memo."""
    marks, end, dead = [find_marks(tb, rk) for rk in inc], len(tb) // 2, set()

    def go(j: int, p: int):
        if (j, p) in dead: return None
        lo, hi = p + 2 + floors[j], p + 2 + FRAMED_CAP
        if j == len(inc) - 1:
            if lo <= end <= hi: return [p]
        else:
            ms = marks[j + 1]
            for q in ms[bisect_left(ms, lo):bisect_right(ms, hi)]:
                if (r := go(j + 1, q)): return [p] + r
        dead.add((j, p))
        return None
    return go(0, 0) if marks[0][:1] == [0] else None


def partition_diagnostic(tail: str, inc: list[int], floors: dict[int, int]) -> list[str]:
    """Explain a failed partition using the first marker after each previous one."""
    marks, pos = [], 0
    for rk in inc:
        i = tail.find(f"\n\n{HEADER}{rk}\n", pos)
        if i < 0 or (not marks and i != 0): return [f"extra text lacks the block header for rank {rk} in order"]
        marks.append(i)
        pos = i + len(f"\n\n{HEADER}{rk}\n")
    out = []
    for rk, a, b in zip(inc, marks, marks[1:] + [len(tail)]):
        size = u16(tail[a + 2:b])
        if size > FRAMED_CAP: out.append(f"extra block rank {rk} is {size} UTF-16 units, over {FRAMED_CAP}")
        elif size < floors[rk]: out.append(f"extra block rank {rk} is {size} UTF-16 units, under its framing floor {floors[rk]}")
    return out or ["extra text admits no complete partition into the included blocks"]


def additive_problems(ev: dict, text: str, n: int, srcs: list, sources_ok: bool) -> list[str]:
    add = ev.get("additive")
    if not isinstance(add, dict): return ["candidate evidence.additive diagnostics missing"]
    base, extra = add.get("base_chars"), add.get("extra_chars")
    if not (nat(base) and nat(extra)): return ["candidate additive base_chars/extra_chars invalid"]
    out: list[str] = []
    if base > BASE_CAP: out.append(f"additive base_chars {base} exceeds {BASE_CAP}")
    if extra > EXTRA_CAP: out.append(f"additive extra_chars {extra} exceeds {EXTRA_CAP}")
    if extra != n - base: out.append(f"additive extra_chars {extra} differs from UTF-16 text length {n} minus base_chars {base}")
    inc, om, sel = add.get("included_ranks"), add.get("omitted"), add.get("selected_occurrences")
    if not (isinstance(inc, list) and all(nat(x) for x in inc) and isinstance(om, list)
            and all(isinstance(o, dict) and nat(o.get("source_rank")) and o.get("reason") in OMIT_REASONS for o in om)):
        return out + ["additive included_ranks/omitted malformed"]
    if not sources_ok: return out
    extras = srcs[ORIGINAL:]
    ranks = [ORIGINAL + 1 + i for i in range(len(extras))]
    if inc != [r for r, s in zip(ranks, extras) if s["used_chars"] > 0]: out.append("additive included_ranks disagree with extra sources that delivered characters")
    if sorted(o["source_rank"] for o in om) != [r for r, s in zip(ranks, extras) if s["used_chars"] == 0]:
        out.append("additive omitted ranks disagree with extra sources that delivered nothing")
    if sel != [s["occurrence"] for s in extras]: out.append("additive selected_occurrences disagree with extra sources")
    if out or n < base: return out
    floors = {rk: framing_floor(rk, srcs[rk - 1]) for rk in inc}
    out += [f"extra source rank {rk} framing needs at least {f}, over {FRAMED_CAP}" for rk, f in floors.items() if f > FRAMED_CAP]
    if out: return out
    tb = text.encode("utf-16-le", "surrogatepass")[2 * base:]
    if not inc: return [] if not tb else ["extra text present without included extra sources"]
    if partition(tb, inc, [floors[r] for r in inc]) is None:
        out += partition_diagnostic(tb.decode("utf-16-le", "surrogatepass"), inc, floors)
    return out


def evidence_problems(row: dict, arm: str) -> list[str]:
    """Row evidence bounds: UTF-16 size caps, source counts, metadata accounting and (candidate) additive character accounting."""
    ev = row.get("evidence")
    if not (isinstance(ev, dict) and isinstance(ev.get("text"), str) and ev["text"]): return ["evidence.text missing"]
    text = ev["text"]
    n, cap, out = u16(text), CONTROL_CAP if arm == "control" else CANDIDATE_CAP, []
    if n > cap: out.append(f"evidence text is {n} UTF-16 units, over {cap}")
    if type(ev.get("chars")) is not int or ev["chars"] != n: out.append(f"evidence.chars {ev.get('chars')} differs from UTF-16 text length {n}")
    srcs = ev.get("sources")
    if not isinstance(srcs, list): return out + ["evidence.sources missing"]
    if not ORIGINAL <= len(srcs) <= (ORIGINAL if arm == "control" else MAX_SOURCES): out.append(f"{arm} has {len(srcs)} sources")
    bad = [p for i, s in enumerate(srcs) for p in source_problems(s, f"sources[{i}]", arm == "candidate" and i >= ORIGINAL)]
    out += bad
    if not bad and "full_chars" in ev and ev["full_chars"] != n + sum(s["full_chars"] - s["used_chars"] for s in srcs):
        out.append("evidence.full_chars differs from text length plus undelivered source characters")
    if arm == "control":
        return out + (["control evidence carries additive diagnostics"] if "additive" in ev else [])
    return out + additive_problems(ev, text, n, srcs, not bad)


def physical(call: dict, name: str, parent: dict | None = None):
    """Yield (label, call, parent) for a call and every nested transport failure."""
    yield name, call, parent
    nested = call.get("transport_failures")
    for i, f in enumerate(nested if isinstance(nested, list) else []):
        if isinstance(f, dict): yield from physical(f, f"{name}.transport_failures[{i}]", call)


def usage(rows: list[dict]) -> dict:
    """Observed usage. A call with N attempts has N-1 earlier HTTP attempts whose usage is never recorded, even when the
    final attempt's usage is known, so token totals are lower bounds and `usage_complete` is only true when nothing is unknown."""
    u: dict[str, Any] = {"physical_calls": Counter(), "transport_failures": Counter(), "unknown_usage_calls": Counter(), "tokens": Counter(),
                         "elapsed_ms": Counter(), "attempts": Counter(), "answer_effort": Counter(), "prior_http_attempts_unknown_usage": Counter(),
                         "unknown_usage": [], "prior_attempts_unknown": [], "fallbacks": [], "failed_configs": []}
    for r in rows:
        for k in ("answer_call", "failed_answer_call", "premise_call", "judge_call"):
            if not isinstance(r.get(k), dict): continue
            for label, c, parent in physical(r[k], k):
                u["physical_calls"][k] += 1
                u["transport_failures"][k] += int(parent is not None)
                u["elapsed_ms"][k] += c.get("elapsed_ms") or 0
                u["attempts"][k] += c.get("attempts") or 0
                us = c.get("usage")
                known = isinstance(us, dict) and isinstance(us.get("input_tokens"), int) and isinstance(us.get("output_tokens"), int)
                if type(c.get("attempts")) is int and c["attempts"] > 1:
                    u["prior_http_attempts_unknown_usage"][k] += c["attempts"] - 1
                    u["prior_attempts_unknown"].append({"question_id": r["question_id"], "call": label, "prior_attempts": c["attempts"] - 1, "final_usage_known": known})
                if not known:
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
    out = {k: dict(v) if isinstance(v, Counter) else v for k, v in u.items()}
    out.update(observed_totals_are_lower_bounds=True, usage_complete=not u["unknown_usage"] and not u["prior_attempts_unknown"])
    return out
