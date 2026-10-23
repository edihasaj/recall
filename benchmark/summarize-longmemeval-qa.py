"""Compare completed local QA reports with the pinned published Hindsight artifact."""
import argparse
import datetime
import gzip
import json
from pathlib import Path
from typing import cast

Json = dict[str, object]


def load_report(path: Path) -> Json:
    report = cast(Json, json.loads(path.read_text()))
    if report.get("comparison_valid") is not True or not report.get("generation_blinding"):
        raise ValueError("Only explicitly valid reports with generation blinding can be scored")
    rows = cast(list[Json], report["results"])
    ids = cast(list[str], report["selected_question_ids"])
    if report["status"] != "complete" or len(rows) != len(ids):
        raise ValueError("Only complete reports can be summarized as scores")
    if len(set(ids)) != len(ids) or {str(row["question_id"]) for row in rows} != set(ids):
        raise ValueError("Question identity mismatch")
    if any(type(row["correct"]) is not bool for row in rows):
        raise ValueError("Preparation-only reports do not have answer scores")
    return report


def score(rows: list[Json]) -> Json:
    judged = [row for row in rows if row["error"] is None]
    correct = sum(row["correct"] is True for row in rows)
    return {
        "questions": len(rows), "correct": correct,
        "accuracy": correct / len(rows) if rows else None,
        "request_or_format_errors": len(rows) - len(judged),
        "successfully_judged": len(judged),
        "accuracy_successfully_judged": correct / len(judged) if judged else None,
    }


def summarize(report: Json) -> Json:
    rows = cast(list[Json], report["results"])
    start = datetime.datetime.fromisoformat(str(report["started_at"]).replace("Z", "+00:00"))
    finish = datetime.datetime.fromisoformat(str(report["finished_at"]).replace("Z", "+00:00"))
    calls = [cast(Json, row[kind]) for row in rows for kind in ["ledger_call", "answer_call", "review_call", "judge_call"] if row.get(kind)]
    tokens = {"input": 0, "output": 0, "total": 0}
    missing_usage = 0
    for call in calls:
        usage = cast(Json | None, call["usage"])
        if usage is None:
            missing_usage += 1
            continue
        for key, aliases in {"input": ["input_tokens", "prompt_tokens", "promptTokenCount"], "output": ["output_tokens", "completion_tokens", "candidatesTokenCount"], "total": ["total_tokens", "totalTokenCount"]}.items():
            value = next((usage[name] for name in aliases if name in usage), None)
            if type(value) is int:
                tokens[key] += cast(int, value)
    errors = sorted({str(row["error"]) for row in rows if row["error"]})
    source_context_chars = sum(cast(int, cast(Json, row["evidence"])["chars"]) for row in rows if row["evidence"])
    ledger_context_chars = sum(
        cast(int, row.get("ledger_chars", 0))
        for row in rows if type(row.get("ledger_chars", 0)) is int and cast(int, row.get("ledger_chars", 0)) >= 0
    )
    return {
        **score(rows), "elapsed_seconds": (finish - start).total_seconds(),
        "models": sorted({str(call["model"]) for call in calls}),
        "by_type": {category: score([row for row in rows if row["question_type"] == category]) for category in sorted({str(row["question_type"]) for row in rows})},
        "abstention": score([row for row in rows if row["is_abstention"]]),
        "errors_by_kind": {error: sum(row["error"] == error for row in rows) for error in errors},
        "observed_tokens": tokens, "calls_with_missing_usage": missing_usage, "cost_usd": None,
        "source_evidence_chars_mean": source_context_chars / len(rows),
        "derived_ledger_chars_mean": ledger_context_chars / len(rows),
        "answer_context_chars_mean": (source_context_chars + ledger_context_chars) / len(rows),
        "truncated_questions": sum(any(source["truncated"] for source in cast(list[Json], cast(Json, row["evidence"])["sources"])) for row in rows if row["evidence"]),
        "cached_ambiguous_questions": sum(bool(row.get("cached_ambiguous_session_ids", [])) for row in rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lexical", type=Path, required=True)
    parser.add_argument("--cached", type=Path)
    parser.add_argument("--hindsight", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit("Output already exists; choose a new path")
    published = json.loads(gzip.decompress(args.hindsight.read_bytes()))
    hindsight = {row["query_id"]: row for row in published["results"]}
    lexical = load_report(args.lexical)
    output: Json = {
        "published_hindsight_metadata": {key: value for key, value in published.items() if key != "results"},
        "fresh_lexical": summarize(lexical),
        "limitations": [
            "Different answer and judge models; these are not matched system scores.",
            "Successfully judged accuracy excludes resource and format failures; the primary score includes them.",
            "Supplied-ranking reconstruction and fresh lexical search are different retrieval configurations; inspect ranking provenance.",
            "Observed token usage excludes failed calls with unknown usage. Dollar cost is unknown.",
        ],
    }
    if args.cached:
        cached = load_report(args.cached)
        cached_rows = cast(list[Json], cached["results"])
        ids = {str(row["question_id"]) for row in cached_rows}
        lexical_subset = [row for row in cast(list[Json], lexical["results"]) if row["question_id"] in ids]
        if len(lexical_subset) != len(ids) or not ids <= hindsight.keys():
            raise ValueError("Comparison questions are missing")
        by_id = {str(row["question_id"]): row for row in lexical_subset}
        output["cached_hybrid_reconstruction"] = summarize(cached)
        output["same_cached_questions"] = {
            "questions": len(ids), "published_hindsight_correct": sum(hindsight[key]["correct"] for key in ids),
            "fresh_lexical": score(lexical_subset), "cached_hybrid": score(cached_rows),
            "hybrid_only_correct": sum(row["correct"] is True and by_id[str(row["question_id"])]["correct"] is False for row in cached_rows),
            "lexical_only_correct": sum(row["correct"] is False and by_id[str(row["question_id"])]["correct"] is True for row in cached_rows),
        }
    with args.out.open("x") as destination:
        json.dump(output, destination, indent=2)
        destination.write("\n")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
