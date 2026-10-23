"""Freeze AMB's literal prompt templates and the existing public corpus; no external code execution."""
import argparse
import ast
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import urllib.request

COMMIT = "aef3702e0586a959c845cc2c61f10d5e8ff0f94a"
BASE = f"https://raw.githubusercontent.com/vectorize-io/agent-memory-benchmark/{COMMIT}/"
FILES = [
    "src/memory_bench/dataset/longmemeval.py",
    "src/memory_bench/modes/rag.py",
    "src/memory_bench/llm/gemini.py",
    "src/memory_bench/judge.py",
    "outputs/longmemeval/hindsight/rag/s.json.gz",
]


def render(node: ast.AST, values: dict[str, str]) -> str:
    if isinstance(node, ast.Constant):
        return str(node.value)
    if isinstance(node, ast.JoinedStr):
        return "".join(render(part, values) for part in node.values)
    if isinstance(node, ast.FormattedValue) and isinstance(node.value, ast.Name):
        return values[node.value.id]
    raise ValueError("Unsupported expression in external prompt template")


def parse_date(value: str) -> str:
    # Reproduce AMB's published parser, including dropping time after the weekday.
    cleaned = value.split("(")[0].strip() if "(" in value else value
    for fmt in ["%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d"]:
        try:
            return datetime.datetime.strptime(cleaned, fmt).replace(tzinfo=datetime.timezone.utc).isoformat()
        except ValueError:
            pass
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=Path("benchmark/data/longmemeval_s_cleaned.json"))
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit("Output already exists; choose a new path")
    args.sources.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        dest = args.sources / name.rsplit("/", 1)[-1]
        downloaded = urllib.request.urlopen(BASE + name, timeout=60).read()
        if dest.exists() and dest.read_bytes() != downloaded:
            raise SystemExit(f"Existing source differs from pinned upstream: {dest.name}")
        if not dest.exists():
            dest.write_bytes(downloaded)
    source = args.sources / "longmemeval.py"
    tree = ast.parse(source.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "LongMemEvalDataset")
    rag = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "build_rag_prompt")
    answer = next(n.value for n in ast.walk(rag) if isinstance(n, ast.Return) and isinstance(n.value, ast.JoinedStr))
    judge = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "get_judge_prompt_fn")
    templates = [n.value for n in ast.walk(judge) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "prompt_content" for t in n.targets)]
    categories = ["single-session-user", "temporal-reasoning", "knowledge-update", "single-session-preference", "fallback"]
    if len(templates) != len(categories):
        raise SystemExit("Upstream judge template layout changed")
    raw = args.dataset.read_bytes()
    cases = []
    for row in json.loads(raw):
        category = row["question_type"] if row["question_type"] in categories else "single-session-user"
        sessions = [
            {"id": sid, "date": date, "text": "\n".join(f"{t['role']}: {t['content']}" for t in turns)}
            for sid, date, turns in zip(row["haystack_session_ids"], row["haystack_dates"], row["haystack_sessions"], strict=True)
        ]
        cases.append({
            "question_id": row["question_id"], "question_type": row["question_type"],
            "is_abstention": "_abs" in row["question_id"], "question": row["question"],
            "question_date": row["question_date"], "reference": str(row["answer"]),
            "gold_session_ids": row["answer_session_ids"], "sessions": sessions,
            "answer_prompt_prefix": render(answer, {"query": row["question"], "formatted_date": parse_date(row["question_date"]), "ctx": "__RECALL_CONTEXT__"}),
            "judge_prompt_template": render(templates[categories.index(category)], {"query": row["question"], "gold_str": str(row["answer"]), "answer": "__RECALL_CANDIDATE__"}),
        })
    published = json.loads(gzip.decompress((args.sources / "s.json.gz").read_bytes()))
    metadata = {key: value for key, value in published.items() if key != "results"}
    provenance = {
        "source_repo": "https://github.com/vectorize-io/agent-memory-benchmark", "source_commit": COMMIT,
        "dataset_sha256": hashlib.sha256(raw).hexdigest(),
        "source_hashes": {name.rsplit("/", 1)[-1]: hashlib.sha256((args.sources / name.rsplit("/", 1)[-1]).read_bytes()).hexdigest() for name in FILES},
        "prompt_extraction": "AST literal f-string rendering only; no execution/import of external Python",
        "session_representation": "role: content, same as Recall retrieval harness, rather than AMB JSON serialization",
        "date_formatting": "matches AMB dataset _parse_date including its weekday time stripping",
        "hindsight_published_metadata": metadata,
    }
    with args.out.open("x") as output:
        json.dump({"provenance": provenance, "cases": cases}, output, ensure_ascii=False)
    print(json.dumps({"questions": len(cases), "abstention": sum(row["is_abstention"] for row in cases), "out": str(args.out)}))


if __name__ == "__main__":
    main()
