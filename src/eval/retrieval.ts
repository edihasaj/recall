import { readFileSync } from "node:fs";
import { compileContext, compileContextHybrid } from "../compiler/context.js";
import type { RecallDb } from "../db/client.js";
import type { EmbeddingConfig } from "../types.js";
import { getMemory } from "../models/memory.js";
import { bootstrapEmbeddings, loadEmbeddingConfigFromEnv } from "../embeddings/embeddings.js";
import {
  RetrievalEvalCase,
  RetrievalEvalFile,
  type CompilerConfig,
  type RetrievalEvalFile as RetrievalEvalFileType,
} from "../types.js";

type EvalRunName = "baseline" | "hybrid";
type RetrievalEvalProvider = EmbeddingConfig["provider"] | "current";

interface RetrievalRunResult {
  included_ids: string[];
  included_texts: string[];
  token_estimate: number;
  passed: boolean;
  expected_all_missing: string[];
  expected_any_hit: boolean;
  forbidden_hits: string[];
  first_expected_rank: number | null;
  count_violation?: string;
}

export interface RetrievalEvalCaseResult {
  name: string;
  baseline: RetrievalRunResult;
  hybrid: RetrievalRunResult;
  improved: boolean;
  regressed: boolean;
}

export interface RetrievalEvalSummary {
  total_cases: number;
  baseline_passed: number;
  hybrid_passed: number;
  improved_cases: number;
  regressed_cases: number;
  baseline_expected_any_hit_rate: number;
  hybrid_expected_any_hit_rate: number;
  baseline_forbidden_hit_rate: number;
  hybrid_forbidden_hit_rate: number;
}

export interface RetrievalEvalReport {
  summary: RetrievalEvalSummary;
  cases: RetrievalEvalCaseResult[];
  provider_reports: RetrievalEvalProviderReport[];
}

export interface RetrievalEvalProviderMetrics {
  recall_at_k: number;
  mrr: number;
  override_rate: number;
}

export interface RetrievalEvalProviderReport {
  provider: RetrievalEvalProvider;
  summary: RetrievalEvalSummary;
  metrics: RetrievalEvalProviderMetrics;
  cases: RetrievalEvalCaseResult[];
}

export function loadRetrievalEvalFile(path: string): RetrievalEvalFileType {
  return RetrievalEvalFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function runRetrievalEval(
  db: RecallDb,
  input: RetrievalEvalFileType,
  options: { providers?: RetrievalEvalProvider[] } = {},
): Promise<RetrievalEvalReport> {
  const providers: RetrievalEvalProvider[] = options.providers?.length ? options.providers : ["current"];
  const providerReports: RetrievalEvalProviderReport[] = [];

  for (const provider of providers) {
    const cases: RetrievalEvalCaseResult[] = [];
    const embeddingConfig = provider === "current"
      ? loadEmbeddingConfigFromEnv()
      : embeddingConfigForProvider(provider);

    if (embeddingConfig) {
      await bootstrapEmbeddings(db, embeddingConfig);
    }

    for (const raw of input.cases) {
      const testCase = RetrievalEvalCase.parse(raw);
      const config = caseConfig(testCase);

      const baselineCompiled = compileContext(db, {
        repo: testCase.repo,
        path: testCase.path,
        config,
      });
      const hybridCompiled = await compileContextHybrid(db, {
        repo: testCase.repo,
        path: testCase.path,
        query_text: testCase.query_text,
        config: {
          ...config,
          include_candidates: testCase.include_candidates,
        },
        embedding_config: embeddingConfig,
      });

      const baseline = evaluateCaseRun(db, testCase, baselineCompiled.memories_included, baselineCompiled.token_estimate);
      const hybrid = evaluateCaseRun(db, testCase, hybridCompiled.memories_included, hybridCompiled.token_estimate);

      cases.push({
        name: testCase.name,
        baseline,
        hybrid,
        improved: !baseline.passed && hybrid.passed,
        regressed: baseline.passed && !hybrid.passed,
      });
    }

    const total = cases.length;
    const baselinePassed = cases.filter((item) => item.baseline.passed).length;
    const hybridPassed = cases.filter((item) => item.hybrid.passed).length;
    const improved = cases.filter((item) => item.improved).length;
    const regressed = cases.filter((item) => item.regressed).length;

    const baselineExpectedAnyHits = cases.filter((item) => item.baseline.expected_any_hit).length;
    const hybridExpectedAnyHits = cases.filter((item) => item.hybrid.expected_any_hit).length;
    const baselineForbiddenHits = cases.filter((item) => item.baseline.forbidden_hits.length > 0).length;
    const hybridForbiddenHits = cases.filter((item) => item.hybrid.forbidden_hits.length > 0).length;
    const reciprocalRanks = cases
      .map((item) => item.hybrid.first_expected_rank)
      .filter((rank): rank is number => rank != null)
      .map((rank) => 1 / rank);

    providerReports.push({
      provider,
      summary: {
        total_cases: total,
        baseline_passed: baselinePassed,
        hybrid_passed: hybridPassed,
        improved_cases: improved,
        regressed_cases: regressed,
        baseline_expected_any_hit_rate: ratio(baselineExpectedAnyHits, total),
        hybrid_expected_any_hit_rate: ratio(hybridExpectedAnyHits, total),
        baseline_forbidden_hit_rate: ratio(baselineForbiddenHits, total),
        hybrid_forbidden_hit_rate: ratio(hybridForbiddenHits, total),
      },
      metrics: {
        recall_at_k: ratio(hybridExpectedAnyHits, total),
        mrr: reciprocalRanks.length > 0
          ? reciprocalRanks.reduce((sum, value) => sum + value, 0) / total
          : 0,
        override_rate: ratio(hybridForbiddenHits, total),
      },
      cases,
    });
  }

  return {
    summary: providerReports[0].summary,
    cases: providerReports[0].cases,
    provider_reports: providerReports,
  };
}

export function formatRetrievalEvalReport(report: RetrievalEvalReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  if (report.provider_reports.length > 1) {
    const lines = [
      "# Retrieval Eval",
      "",
      "## Provider Comparison",
    ];

    for (const provider of report.provider_reports) {
      lines.push(
        `- ${provider.provider}: passed=${provider.summary.hybrid_passed}/${provider.summary.total_cases} recall@k=${pct(provider.metrics.recall_at_k)} mrr=${provider.metrics.mrr.toFixed(3)} override=${pct(provider.metrics.override_rate)}`,
      );
    }

    for (const provider of report.provider_reports) {
      lines.push("", `## ${provider.provider}`);
      lines.push(formatSingleProviderReport(provider.summary, provider.cases));
    }

    return lines.join("\n");
  }

  return formatSingleProviderReport(report.summary, report.cases);
}

function formatSingleProviderReport(
  summary: RetrievalEvalSummary,
  cases: RetrievalEvalCaseResult[],
) {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Retrieval Eval",
    "",
    `Cases: ${summary.total_cases}`,
    `Baseline passed: ${summary.baseline_passed}`,
    `Hybrid passed:   ${summary.hybrid_passed}`,
    `Improved:        ${summary.improved_cases}`,
    `Regressed:       ${summary.regressed_cases}`,
    "",
    `Baseline expected-any hit rate: ${pct(summary.baseline_expected_any_hit_rate)}`,
    `Hybrid expected-any hit rate:   ${pct(summary.hybrid_expected_any_hit_rate)}`,
    `Baseline forbidden hit rate:    ${pct(summary.baseline_forbidden_hit_rate)}`,
    `Hybrid forbidden hit rate:      ${pct(summary.hybrid_forbidden_hit_rate)}`,
  ];

  const failedCases = cases.filter((item) => !item.hybrid.passed || item.regressed || item.improved);
  if (failedCases.length > 0) {
    lines.push("", "## Case Details");
    for (const item of failedCases) {
      lines.push(`- ${item.name}`);
      lines.push(`  baseline: ${describeRun(item.baseline)}`);
      lines.push(`  hybrid:   ${describeRun(item.hybrid)}`);
    }
  }

  return lines.join("\n");
}

function caseConfig(testCase: RetrievalEvalCase): Partial<CompilerConfig> {
  return {
    ...(testCase.confidence_threshold != null ? { confidence_threshold: testCase.confidence_threshold } : {}),
    ...(testCase.max_lines != null ? { max_lines: testCase.max_lines } : {}),
    ...(testCase.max_commands != null ? { max_commands: testCase.max_commands } : {}),
    ...(testCase.max_gotchas != null ? { max_gotchas: testCase.max_gotchas } : {}),
    ...(testCase.token_budget != null ? { token_budget: testCase.token_budget } : {}),
  };
}

function evaluateCaseRun(
  db: RecallDb,
  testCase: RetrievalEvalCase,
  memoryIds: string[],
  tokenEstimate: number,
): RetrievalRunResult {
  const includedTexts = memoryIds
    .map((id) => getMemory(db, id)?.text)
    .filter((text): text is string => Boolean(text));

  const expectedAllMissing = testCase.expected_all_texts.filter((expected) => !includedTexts.includes(expected));
  const expectedAnyHit = testCase.expected_any_texts.length === 0
    ? true
    : testCase.expected_any_texts.some((expected) => includedTexts.includes(expected));
  const forbiddenHits = testCase.forbidden_texts.filter((forbidden) => includedTexts.includes(forbidden));
  const relevantTexts = [
    ...testCase.expected_all_texts,
    ...testCase.expected_any_texts,
  ];
  const firstExpectedRank = relevantTexts.length === 0
    ? null
    : includedTexts.findIndex((text) => relevantTexts.includes(text)) + 1 || null;

  let countViolation: string | undefined;
  if (testCase.min_included != null && memoryIds.length < testCase.min_included) {
    countViolation = `included ${memoryIds.length} < min ${testCase.min_included}`;
  } else if (testCase.max_included != null && memoryIds.length > testCase.max_included) {
    countViolation = `included ${memoryIds.length} > max ${testCase.max_included}`;
  }

  const passed =
    expectedAllMissing.length === 0 &&
    expectedAnyHit &&
    forbiddenHits.length === 0 &&
    !countViolation;

  return {
    included_ids: memoryIds,
    included_texts: includedTexts,
    token_estimate: tokenEstimate,
    passed,
    expected_all_missing: expectedAllMissing,
    expected_any_hit: expectedAnyHit,
    forbidden_hits: forbiddenHits,
    first_expected_rank: firstExpectedRank,
    count_violation: countViolation,
  };
}

function describeRun(result: RetrievalRunResult) {
  const parts = [
    result.passed ? "pass" : "fail",
    `included=${result.included_ids.length}`,
  ];
  if (result.expected_all_missing.length > 0) {
    parts.push(`missing_all=${result.expected_all_missing.join(" | ")}`);
  }
  if (!result.expected_any_hit) {
    parts.push("expected_any=miss");
  }
  if (result.forbidden_hits.length > 0) {
    parts.push(`forbidden=${result.forbidden_hits.join(" | ")}`);
  }
  if (result.count_violation) {
    parts.push(result.count_violation);
  }
  return parts.join(" ; ");
}

function ratio(value: number, total: number) {
  return total > 0 ? value / total : 0;
}

function embeddingConfigForProvider(provider: Exclude<RetrievalEvalProvider, "current">): EmbeddingConfig {
  const overrideDimensions = process.env.RECALL_EMBEDDING_DIMS
    ? parseInt(process.env.RECALL_EMBEDDING_DIMS, 10)
    : null;
  if (provider === "bge-small-en-v1.5") {
    return {
      provider,
      model: "Xenova/bge-small-en-v1.5",
      dimensions: overrideDimensions ?? 384,
      version: "eval",
      similarity_threshold: 0.8,
    };
  }
  if (provider === "multilingual-e5") {
    return {
      provider,
      model: "Xenova/multilingual-e5-small",
      dimensions: overrideDimensions ?? 384,
      version: "eval",
      similarity_threshold: 0.8,
    };
  }

  return {
    provider: "nomic",
    model: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: overrideDimensions ?? 512,
    version: "eval",
    similarity_threshold: 0.8,
  };
}
