"""Evidence bounds validation for the `statements` candidate arm of the paired trial supervisor.

Loaded by run-longmemeval-additive-trial.py (only for --candidate-evidence statements) without
writing bytecode. Offsets and lengths are JavaScript UTF-16 code units as recorded by the
TypeScript producer. Statement evidence renders the original twenty sources and up to twenty
lexical sources chronologically under neutral `Memory N` labels, so rendered headers can be
date-sorted and may be quoted inside source text: this module never parses them. It checks the
recorded metadata and range bounds only (a preflight); the text itself is not rebuilt here.

Diagnostics are required both in `evidence.statements` and in the row's `statements_diagnostics`
(which spreads it) and must agree with the source metadata: `lexical_pool` 80, `lexical_limit` 20,
`per_source_raw_chars` 4000, `max_chars` 180000, `selected_occurrences` (every source identity, in
order) and `omitted_occurrences` (every source that delivered no characters).
"""
from __future__ import annotations

from typing import Any

TEXT_CAP, RAW_CAP, ORIGINAL, MAX_SOURCES = 180_000, 4_000, 20, 40
LEXICAL_POOL, LEXICAL_LIMIT = 80, 20
DIAGNOSTICS = "statements_diagnostics"
MODE = "original_twenty_plus_lexical_statements"
IDENTITY = ("id", "occurrence", "date", "full_chars")
FIXED = {"lexical_pool": LEXICAL_POOL, "lexical_limit": LEXICAL_LIMIT, "per_source_raw_chars": RAW_CAP, "max_chars": TEXT_CAP}
REPORT = {"mode": MODE, "original_sources": ORIGINAL, **FIXED, "reserve_speaker_units": True}
SOURCE_KEYS = {"id", "occurrence", "date", "ranges", "full_chars", "used_chars", "truncated"}  # speaker spans stay out of the model-visible schema
TURNS_KIND = "longmemeval-source-turns-v1"


def u16(s: str) -> int: return len(s.encode("utf-16-le", "surrogatepass")) // 2
def nat(v: Any) -> bool: return type(v) is int and v >= 0


def source_problems(s: Any, label: str) -> list[str]:
    """Structure of one source's metadata; every source must account exactly for its delivered ranges."""
    if not isinstance(s, dict): return [f"{label} metadata is not an object"]
    out: list[str] = []
    if set(s) != SOURCE_KEYS: out.append(f"{label} keys differ from the source metadata schema: {sorted(set(s) ^ SOURCE_KEYS)}")
    full, used, rs = s.get("full_chars"), s.get("used_chars"), s.get("ranges")
    if not (isinstance(s.get("id"), str) and nat(s.get("occurrence"))): out.append(f"{label} id or occurrence invalid")
    if not isinstance(s.get("date"), str): out.append(f"{label} date is not a string")
    if not (nat(full) and nat(used) and used <= full): return out + [f"{label} full_chars/used_chars invalid"]
    if not isinstance(s.get("truncated"), bool): out.append(f"{label} truncated is not boolean")
    if not isinstance(rs, list): return out + [f"{label} ranges is not a list"]
    prev = total = 0
    for r in rs:
        if not (isinstance(r, dict) and nat(r.get("start")) and nat(r.get("end")) and r["start"] < r["end"] <= full) or r["start"] < prev:
            return out + [f"{label} ranges invalid, unordered, overlapping or outside the source"]
        prev, total = r["end"], total + r["end"] - r["start"]
    if used != total: out.append(f"{label} used_chars {used} differs from range total {total}")
    if used > RAW_CAP: out.append(f"{label} used_chars {used} exceeds {RAW_CAP}")
    whole = len(rs) == 1 and rs[0]["start"] == 0 and rs[0]["end"] == full
    if isinstance(s.get("truncated"), bool) and s["truncated"] is not ((not whole) if rs else full > 0):
        out.append(f"{label} truncated flag disagrees with its ranges")
    return out


def diagnostics_problems(d: Any, label: str, srcs: list[dict]) -> list[str]:
    if not isinstance(d, dict): return [f"{label} missing"]
    out = [f"{label}.{k} {d.get(k)} want {want}" for k, want in FIXED.items() if type(d.get(k)) is not int or d[k] != want]
    if d.get("selected_occurrences") != [s["occurrence"] for s in srcs]:
        out.append(f"{label} selected_occurrences disagree with the source identities")
    om, empty = d.get("omitted_occurrences"), sorted(s["occurrence"] for s in srcs if s["used_chars"] == 0)
    if not (isinstance(om, list) and all(nat(x) for x in om) and sorted(om) == empty):
        out.append(f"{label} omitted_occurrences disagree with sources that delivered nothing")
    return out


def evidence_problems(row: dict) -> list[str]:
    """Row evidence bounds: UTF-16 size caps, source counts and uniqueness, metadata accounting and diagnostics."""
    ev = row.get("evidence")
    if not (isinstance(ev, dict) and isinstance(ev.get("text"), str) and ev["text"]): return ["evidence.text missing"]
    n, out = u16(ev["text"]), []
    if n > TEXT_CAP: out.append(f"evidence text is {n} UTF-16 units, over {TEXT_CAP}")
    if type(ev.get("chars")) is not int or ev["chars"] != n: out.append(f"evidence.chars {ev.get('chars')} differs from UTF-16 text length {n}")
    if "additive" in ev or "additive_diagnostics" in row: out.append("statements candidate carries additive diagnostics")
    srcs = ev.get("sources")
    if not isinstance(srcs, list): return out + ["evidence.sources missing"]
    if not ORIGINAL <= len(srcs) <= MAX_SOURCES: out.append(f"statements candidate has {len(srcs)} sources")
    bad = [p for i, s in enumerate(srcs) for p in source_problems(s, f"sources[{i}]")]
    if bad: return out + bad
    if len({s["occurrence"] for s in srcs}) != len(srcs): return out + ["source occurrences are not unique"]
    if "full_chars" in ev and ev["full_chars"] != n + sum(s["full_chars"] - s["used_chars"] for s in srcs):
        out.append("evidence.full_chars differs from text length plus undelivered source characters")
    if n < sum(s["used_chars"] for s in srcs): out.append("evidence text is shorter than the characters its sources delivered")
    return out + diagnostics_problems(ev.get("statements"), "evidence.statements", srcs) + diagnostics_problems(row.get(DIAGNOSTICS), DIAGNOSTICS, srcs)


def _identities(row: Any) -> list[tuple] | None:
    ev = row.get("evidence") if isinstance(row, dict) else None
    srcs = ev.get("sources") if isinstance(ev, dict) else None
    if not isinstance(srcs, list): return None
    return [tuple(s.get(k) if isinstance(s, dict) else None for k in IDENTITY) for s in srcs]


def parity_problems(control: dict | None, candidate: dict | None) -> list[str]:
    """The candidate's first twenty source identities (id, occurrence, date, full length) must equal the control's.
    Delivered ranges and text intentionally differ, and there is no prefix requirement."""
    c, k = _identities(control), _identities(candidate)
    if c is None or k is None or len(c) != ORIGINAL or len(k) < ORIGINAL: return ["source metadata missing or the wrong count"]
    return [] if k[:ORIGINAL] == c else ["candidate first 20 source identities differ from control metadata"]


def report_problems(report: dict, arm: str) -> list[str]:
    """Report-level provenance: the candidate declares the fixed statement settings and the control carries none."""
    out = ["report carries additive_evidence"] if "additive_evidence" in report else []
    got = report.get("statement_evidence")
    if arm == "control": return out + (["control report carries statement_evidence"] if "statement_evidence" in report else [])
    if not isinstance(got, dict): return out + ["statement_evidence missing"]
    return out + [f"statement_evidence {k}={got.get(k)} want {v}" for k, v in REPORT.items() if got.get(k) != v or type(got.get(k)) is not type(v)]


def turns_manifest_problems(m: Any, ids: list[str], input_sha: str, raw_sha: Any) -> list[str]:
    """Preflight of the trusted source-turns manifest: kind, the baseline-bound original input hash, the raw dataset hash and a
    non-empty entry for every selected question (`cases` as an object keyed by question id or a list of objects with `question_id`).
    Per-turn fields are validated by the QA run itself before any credential is used."""
    if not isinstance(m, dict): return ["source turns manifest is not an object"]
    out = [f"source turns kind {m.get('kind')} want {TURNS_KIND}"] if m.get("kind") != TURNS_KIND else []
    if m.get("input_sha256") != input_sha: out.append("source turns input_sha256 differs from the baseline-bound input")
    if not (isinstance(raw_sha, str) and raw_sha and m.get("raw_dataset_sha256") == raw_sha): out.append("source turns raw_dataset_sha256 differs from the input provenance dataset_sha256")
    cases = m.get("cases")
    if isinstance(cases, list): cases = {c.get("question_id", c.get("qid")): c for c in cases if isinstance(c, dict)}
    if not isinstance(cases, dict): return out + ["source turns cases missing"]
    missing = sorted(q for q in ids if not cases.get(q))
    return out + ([f"{len(missing)} selected questions lack source turns, first {missing[:5]}"] if missing else [])


def turns_problems(report: dict, arm: str, expect: dict | None, n: int) -> list[str]:
    """Only the candidate reads the manifest; its report must name the frozen file and the hashes it was verified against."""
    inv, got = report.get("invocation") or {}, report.get("source_turns_manifest")
    if arm == "control":
        return ["control invocation carries sourceTurns"] * (inv.get("sourceTurns") is not None) + ["control report carries source_turns_manifest"] * (got is not None)
    if not isinstance(expect, dict): return ["source turns expectation missing"]
    out = [f"invocation sourceTurns={inv.get('sourceTurns')} want {expect['path']}"] if inv.get("sourceTurns") != expect["path"] else []
    if not isinstance(got, dict): return out + ["source_turns_manifest missing"]
    want = {k: expect[k] for k in ("path", "sha256", "input_sha256", "raw_dataset_sha256")} | {"verified_cases": n}
    return out + [f"source_turns_manifest {k}={got.get(k)} want {v}" for k, v in want.items() if got.get(k) != v or type(got.get(k)) is not type(v)]
