/** Answer retained Cloud contexts with an explicitly selected frozen evaluator runtime. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Call = {
  text: string | null;
  error: string | null;
  attempts: number;
  elapsed_ms: number;
  model: string;
  usage: Record<string, unknown> | null;
  prompt_sha256: string;
  request_config?: {
    reasoning_effort: string | null;
    max_output_tokens: number;
  };
};
export type ModelCall = (
  kind: "answer" | "judge" | "premise",
  prompt: string,
  meta?: { question?: string; effort?: string; timeoutMs?: number },
) => Promise<Call>;
export type Runtime = {
  sha256: (value: string | Buffer) => string;
  answerPrompt: (
    item: { answer_prompt_prefix: string },
    context: string,
  ) => string;
  judgePrompt: (
    item: { judge_prompt_template: string },
    answer: string,
  ) => string;
  parseAnswer: (text: string | null) => string | null;
  parseJudge: (text: string | null) => boolean | null;
  parseObject: (text: string | null) => Record<string, unknown> | null;
  createModelCall: (
    provider: "qwen-local",
    fetcher: typeof fetch,
    options: Record<string, unknown>,
  ) => ModelCall;
  answerGenerationClock: (prompt: string) => string;
  answerOnce: (
    call: ModelCall,
    prompt: string,
    question: string,
    recovery: "longer-timeout-transport",
  ) => Promise<{
    answerCall: Call;
    failed: Call | null;
    recovered: boolean | undefined;
  }>;
  withTransportRetry: (call: ModelCall) => ModelCall;
  premiseCheckPrompt: (
    question: string,
    clock: string,
    evidence: string,
  ) => string;
  premiseAbstention: (reason: string) => string;
  MINIMAL_ANSWER_POLICY: string;
  longRequestFetch: typeof fetch;
};

const RUNTIME_ENTRIES = [
  "benchmark/longmemeval-qa-support.ts",
  "benchmark/longmemeval-qa-transport.ts",
  "benchmark/longmemeval-inference-policy.ts",
  "benchmark/longmemeval-answer-sampling.ts",
  "benchmark/longmemeval-minimal-answer-policy.ts",
  "benchmark/longmemeval-premise-check.ts",
  "benchmark/longmemeval-answer-review.ts",
  "package-lock.json",
] as const;

export type Prepared = {
  question_id: string;
  question_type: string;
  is_abstention: boolean;
  question: string;
  reference: string;
  gold_session_ids: string[];
  answer_prompt_prefix: string;
  judge_prompt_template: string;
};
export type CloudContext = {
  question_id: string;
  context: string;
  context_sha256: string;
  policy: string;
  source_content_sha256: string[];
};
export type HostedRow = {
  question_id: string;
  question_type: string;
  context_sha256: string;
  policy_sha256: string;
  source_content_sha256: string[];
  answer_prompt_sha256: string;
  premise_prompt_sha256: string | null;
  judge_prompt_sha256: string | null;
  answer_call: Call | null;
  failed_answer_call: Call | null;
  answer_recovered: boolean | null;
  premise_call: Call | null;
  premise_recorded: boolean | null;
  premise_override: boolean;
  judge_call: Call | null;
  answer: string | null;
  correct: boolean | null;
  error: string | null;
};
export type HostedOptions = {
  contexts: string;
  prepared: string;
  retrievalReport: string;
  sourceRoot: string;
  out: string;
  concurrency?: number;
  dryRun?: boolean;
  resume?: boolean;
};
export type HostedCallFactory = (
  policy: string,
  runtime: Runtime,
) => { answer: ModelCall; judge: ModelCall };
export type Journal = {
  event: "started" | "finished";
  call_id: string;
  question_id: string;
  stage: "answer" | "premise" | "judge";
  prompt_sha256: string;
  meta: Record<string, unknown> | null;
  call?: Call;
};

export const outputs = (out: string) => ({
  report: out,
  rows: `${out}.jsonl`,
  calls: `${out}.calls.jsonl`,
  progress: `${out}.progress.json`,
});
export const json = <T,>(path: string) => {
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString()) as T, bytes };
};
export const jsonl = <T,>(path: string) => {
  const bytes = readFileSync(path);
  return {
    rows: bytes
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T),
    bytes,
  };
};
export function durableAppend(path: string, value: unknown) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export async function loadRuntime(sourceRoot: string): Promise<Runtime> {
  const root = realpathSync(sourceRoot);
  const load = (relative: string) =>
    import(pathToFileURL(join(root, relative)).href);
  const [support, transport, sampling, minimal, premise, review] =
    await Promise.all([
      load("benchmark/longmemeval-qa-support.ts"),
      load("benchmark/longmemeval-qa-transport.ts"),
      load("benchmark/longmemeval-answer-sampling.ts"),
      load("benchmark/longmemeval-minimal-answer-policy.ts"),
      load("benchmark/longmemeval-premise-check.ts"),
      load("benchmark/longmemeval-answer-review.ts"),
    ]);
  return {
    ...support,
    ...transport,
    ...sampling,
    ...minimal,
    ...premise,
    ...review,
  } as Runtime;
}
export function hashes(root: string, sha256: Runtime["sha256"]) {
  const pending = RUNTIME_ENTRIES.map((file) => join(root, file));
  const files = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    const text = readFileSync(file, "utf8");
    files.add(file);
    for (const match of text.matchAll(
      /(?:from\s*|import\s*)["']([^"']+)["']/g,
    )) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const base = join(file, "..");
      const target = join(base, specifier);
      const choices = specifier.endsWith(".js")
        ? [
            target.slice(0, -3) + ".ts",
            target.slice(0, -3) + ".mts",
            target.slice(0, -3) + ".json",
          ]
        : [target];
      const resolved = choices.find(existsSync);
      if (resolved) pending.push(resolved);
    }
  }
  return Object.fromEntries(
    [...files]
      .sort()
      .map((file) => [file.slice(root.length + 1), sha256(readFileSync(file))]),
  );
}

export function validateRetrieval(
  contexts: CloudContext[],
  retrieval: Record<string, unknown>,
) {
  const ids = contexts.map((item) => item.question_id);
  const selected = retrieval.selected_ids;
  if (
    retrieval.status !== "complete" ||
    retrieval.error_cases !== 0 ||
    retrieval.completed_cases !== retrieval.selected_denominator ||
    !Array.isArray(selected)
  )
    throw new Error("Retrieval report is incomplete");
  if (
    selected.length !== ids.length ||
    selected.some((id, index) => id !== ids[index])
  )
    throw new Error("Retrieval report IDs do not exactly match contexts");
}
export function validate(
  contexts: CloudContext[],
  prepared: Prepared[],
  rt: Runtime,
) {
  const byId = new Map<string, Prepared>();
  for (const item of prepared) {
    if (
      !item?.question_id ||
      byId.has(item.question_id) ||
      typeof item.question !== "string" ||
      typeof item.reference !== "string" ||
      !Array.isArray(item.gold_session_ids)
    )
      throw new Error("Invalid prepared input");
    rt.answerPrompt(item, "context");
    rt.judgePrompt(item, "candidate");
    rt.answerGenerationClock(item.answer_prompt_prefix);
    byId.set(item.question_id, item);
  }
  const seen = new Set<string>();
  for (const item of contexts) {
    if (
      !item?.question_id ||
      seen.has(item.question_id) ||
      !byId.has(item.question_id) ||
      item.context_sha256 !== rt.sha256(item.context) ||
      !Array.isArray(item.source_content_sha256)
    )
      throw new Error("Invalid Cloud context input");
    seen.add(item.question_id);
  }
  return byId;
}
export function modelCallOptions(policy: string, minimalAnswerPolicy: string) {
  return {
    answer: {
      structuredOutput: true,
      reasoningEffort: "adaptive" as const,
      maxOutputTokens: 16_384,
      answerInstructions: `${policy}\n\n${minimalAnswerPolicy}`,
    },
    judge: {
      structuredOutput: true,
      reasoningEffort: "none" as const,
      maxOutputTokens: 4_096,
    },
  };
}
export function nativeCalls(policy: string, rt: Runtime) {
  const options = modelCallOptions(policy, rt.MINIMAL_ANSWER_POLICY);
  return {
    answer: rt.createModelCall(
      "qwen-local",
      rt.longRequestFetch,
      options.answer,
    ),
    judge: rt.createModelCall("qwen-local", rt.longRequestFetch, options.judge),
  };
}
export function journaled(
  questionId: string,
  path: string,
  call: ModelCall,
  rt: Runtime,
): ModelCall {
  let sequence = 0;
  return async (kind, prompt, meta) => {
    const event: Journal = {
      event: "started",
      call_id: `${questionId}:${kind}:${++sequence}`,
      question_id: questionId,
      stage: kind,
      prompt_sha256: rt.sha256(prompt),
      meta: meta ?? null,
    };
    durableAppend(path, event);
    const result = await call(kind, prompt, meta);
    durableAppend(path, { ...event, event: "finished", call: result });
    return result;
  };
}
