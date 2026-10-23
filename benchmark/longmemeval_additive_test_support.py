"""Shared offline fixtures for the additive-trial tests: rows shaped like the real QA reports."""
MODEL = "qwen3.8-flash-next"


def u16(s): return len(s.encode("utf-16-le", "surrogatepass")) // 2
def effort_of(q): return "high" if (int(q[1:]) if q[1:].isdigit() else 0) % 3 == 0 else "low"


def call(effort, tokens=16384, prompt="p", error=None, usage=True, adaptive=False, **extra):
    u = {"input_tokens": 10, "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 2}} if usage else None
    cfg = {"reasoning_effort": effort, "max_output_tokens": tokens}
    if adaptive: cfg["requested_reasoning_effort"] = "adaptive"
    return {"error": error, "model": MODEL, "prompt_sha256": prompt, "usage": u, "elapsed_ms": 7, "attempts": 1, "request_config": cfg, **extra}


def src(sid, occ, full=100):
    return {"id": sid, "occurrence": occ, "date": "2024-01-01", "full_chars": full, "used_chars": full, "truncated": False, "ranges": [{"start": 0, "end": full}]}


def evidence(q, arm):
    base, srcs = "e" + q, [src(f"{q}-s{i}", i) for i in range(20)]
    if arm == "control": return {"text": base, "chars": u16(base), "full_chars": u16(base), "sources": srcs}
    extra = "\n\n## Lexical Memory 21\n" + "y" * 50
    text = base + extra
    return {"text": text, "chars": u16(text), "full_chars": u16(text), "sources": srcs + [src(q + "-lex0", 100, 50)],
            "additive": {"base_chars": u16(base), "extra_chars": u16(extra), "selected_occurrences": [100], "included_ranks": [21], "omitted": []}}


def good_row(q, correct=True, is_abs=False, arm="control", effort=None):
    effort = effort or effort_of(q)
    return {"question_id": q, "is_abstention": is_abs, "correct": correct, "error": None, "evidence": evidence(q, arm),
            "answer_call": call(effort, prompt=f"p{q}{arm}", adaptive=True), "premise_call": call("low", 4096, "x"),
            "judge_call": call("none", 4096, "j"), "premise_recorded": True}
