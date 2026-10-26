import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateHostedAnswers,
  modelCallOptions,
} from "../scripts/evaluate-hosted-answers.mts";
import {
  sha256,
  type Call,
  type ModelCall,
} from "../benchmark/longmemeval-qa-support.js";

const call = (
  text: string | null,
  error: string | null,
  prompt: string,
  effort: "none" | "low" = "low",
): Call => ({
  text,
  error,
  attempts: 1,
  elapsed_ms: 0,
  model: "fake",
  usage: null,
  prompt_sha256: sha256(prompt),
  request_config: { reasoning_effort: effort, max_output_tokens: 4096 },
});
const root = () => mkdtempSync(join(tmpdir(), "hosted-answer-eval-"));
const prepared = (id = "q1") => ({
  provenance: {},
  cases: [
    {
      question_id: id,
      question_type: "gold-type-must-not-leak",
      is_abstention: false,
      question: "Which private thing did I mention?",
      question_date: "2026/10/25 (Sun) 09:30",
      reference: "GOLD_REFERENCE_MUST_NOT_LEAK",
      gold_session_ids: ["GOLD_SESSION_MUST_NOT_LEAK"],
      answer_prompt_prefix:
        "Answer the user.\nQuestion: Which private thing did I mention?\nQuestion Date: 2026/10/25 (Sun) 09:30\n\nRetrieved Context:\n__RECALL_CONTEXT__",
      judge_prompt_template:
        "Reference answer: GOLD_REFERENCE_MUST_NOT_LEAK\nCandidate: __RECALL_CANDIDATE__",
    },
  ],
});
const context = (id = "q1") => ({
  question_id: id,
  context: "ACTUAL_CLOUD_CONTEXT_ONLY",
  context_sha256: sha256("ACTUAL_CLOUD_CONTEXT_ONLY"),
  policy: "ACTUAL_CLOUD_POLICY_ONLY",
  source_content_sha256: [sha256("raw-source")],
});

describe("evaluate-hosted-answers", () => {
  it("pins the native answer and judge request configuration", () => {
    expect(modelCallOptions("CLOUD_POLICY", "MINIMAL_POLICY")).toEqual({
      answer: {
        structuredOutput: true,
        reasoningEffort: "adaptive",
        maxOutputTokens: 16_384,
        answerInstructions: "CLOUD_POLICY\n\nMINIMAL_POLICY",
      },
      judge: {
        structuredOutput: true,
        reasoningEffort: "none",
        maxOutputTokens: 4_096,
      },
    });
  });

  it("keeps source and gold data out of answer and premise calls, preserves recovery calls, and never rejudges a resumed result", async () => {
    const dir = root(),
      contexts = join(dir, "contexts.jsonl"),
      source = join(dir, "prepared.json"),
      retrieval = join(dir, "retrieval.json"),
      out = join(dir, "report.json"),
      prompts: Array<{
        kind: string;
        prompt: string;
        meta?: { effort?: string; timeoutMs?: number };
      }> = [],
      policies: string[] = [];
    writeFileSync(contexts, `${JSON.stringify(context())}\n`);
    writeFileSync(source, JSON.stringify(prepared()));
    writeFileSync(
      retrieval,
      JSON.stringify({
        status: "complete",
        error_cases: 0,
        completed_cases: 1,
        selected_denominator: 1,
        selected_ids: ["q1"],
      }),
    );
    let answers = 0;
    const factory = (policy: string) => {
      policies.push(policy);
      const answer: ModelCall = async (kind, prompt, meta) => {
        prompts.push({ kind, prompt, meta });
        if (kind === "answer")
          return call(
            ++answers === 1
              ? null
              : JSON.stringify({ reasoning: "r", answer: "visible answer" }),
            answers === 1 ? "timeout" : null,
            prompt,
            (meta?.effort ?? "low") as "none" | "low",
          );
        if (kind === "premise")
          return call(
            JSON.stringify({ correct: true, reason: "" }),
            null,
            prompt,
          );
        throw new Error(`unexpected ${kind}`);
      };
      const judge: ModelCall = async (kind, prompt) => {
        prompts.push({ kind, prompt });
        expect(kind).toBe("judge");
        return call(
          JSON.stringify({ correct: true, reason: "" }),
          null,
          prompt,
          "none",
        );
      };
      return { answer, judge };
    };
    const report = await evaluateHostedAnswers(
      {
        contexts,
        prepared: source,
        retrievalReport: retrieval,
        sourceRoot: process.cwd(),
        out,
      },
      factory,
    );
    expect(report.status).toBe("complete");
    expect(report.results[0]?.answer_recovered).toBe(true);
    expect(report.results[0]?.correct).toBe(true);
    expect(policies).toEqual([
      expect.stringContaining("ACTUAL_CLOUD_POLICY_ONLY"),
    ]);
    expect(
      prompts.filter((item) => item.kind === "answer").map((item) => item.meta),
    ).toEqual([
      {
        question: "Which private thing did I mention?",
      },
      {
        question: "Which private thing did I mention?",
        effort: "low",
        timeoutMs: 1_200_000,
      },
    ]);
    for (const entry of prompts.filter((item) => item.kind !== "judge")) {
      expect(entry.prompt).toContain("ACTUAL_CLOUD_CONTEXT_ONLY");
      expect(entry.prompt).not.toContain("ACTUAL_CLOUD_POLICY_ONLY");
      expect(entry.prompt).not.toContain("GOLD_REFERENCE_MUST_NOT_LEAK");
      expect(entry.prompt).not.toContain("GOLD_SESSION_MUST_NOT_LEAK");
      expect(entry.prompt).not.toContain("gold-type-must-not-leak");
      expect(entry.prompt).not.toContain(sha256("raw-source"));
    }
    expect(prompts.find((item) => item.kind === "judge")?.prompt).toContain(
      "GOLD_REFERENCE_MUST_NOT_LEAK",
    );
    expect(
      readFileSync(`${out}.calls.jsonl`, "utf8").trim().split("\n"),
    ).toHaveLength(8);
    await evaluateHostedAnswers(
      {
        contexts,
        prepared: source,
        retrievalReport: retrieval,
        sourceRoot: process.cwd(),
        out,
        resume: true,
      },
      () => {
        throw new Error("resume must not invoke a model");
      },
    );
    expect(prompts).toHaveLength(4);
  });

  it("prepares a bounded six-context cohort without creating model calls", async () => {
    const dir = root(),
      contexts = join(dir, "contexts.jsonl"),
      source = join(dir, "prepared.json"),
      retrieval = join(dir, "retrieval.json"),
      out = join(dir, "smoke6.json");
    const cases = Array.from(
      { length: 6 },
      (_, index) => prepared(`q${index + 1}`).cases[0]!,
    );
    const rows = cases.map((item) => context(item.question_id));
    writeFileSync(contexts, `${rows.map(JSON.stringify).join("\n")}\n`);
    writeFileSync(source, JSON.stringify({ provenance: {}, cases }));
    writeFileSync(
      retrieval,
      JSON.stringify({
        status: "complete",
        error_cases: 0,
        completed_cases: 6,
        selected_denominator: 6,
        selected_ids: rows.map((row) => row.question_id),
      }),
    );
    const report = await evaluateHostedAnswers(
      {
        contexts,
        prepared: source,
        retrievalReport: retrieval,
        sourceRoot: process.cwd(),
        out,
        dryRun: true,
      },
      () => {
        throw new Error("dry run must not create calls");
      },
    );
    expect(report.status).toBe("prepared");
    expect(report.selected_question_ids).toHaveLength(6);
    expect(report.results).toEqual([]);
  });

  it("refuses to replay an uncertain started call after a crash", async () => {
    const dir = root(),
      contexts = join(dir, "contexts.jsonl"),
      source = join(dir, "prepared.json"),
      retrieval = join(dir, "retrieval.json"),
      out = join(dir, "report.json");
    writeFileSync(contexts, `${JSON.stringify(context())}\n`);
    writeFileSync(source, JSON.stringify(prepared()));
    writeFileSync(
      retrieval,
      JSON.stringify({
        status: "complete",
        error_cases: 0,
        completed_cases: 1,
        selected_denominator: 1,
        selected_ids: ["q1"],
      }),
    );
    await expect(
      evaluateHostedAnswers(
        {
          contexts,
          prepared: source,
          retrievalReport: retrieval,
          sourceRoot: process.cwd(),
          out,
        },
        () => ({
          answer: async () => {
            throw new Error("simulated process loss");
          },
          judge: async () => {
            throw new Error("unreachable");
          },
        }),
      ),
    ).rejects.toThrow("simulated process loss");
    await expect(
      evaluateHostedAnswers(
        {
          contexts,
          prepared: source,
          retrievalReport: retrieval,
          sourceRoot: process.cwd(),
          out,
          resume: true,
        },
        () => {
          throw new Error("must not repeat");
        },
      ),
    ).rejects.toThrow("Refusing to repeat uncertain started calls");
  });
});
