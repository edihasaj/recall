import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type CloudContext,
  type HostedCallFactory,
  type HostedOptions,
  type HostedRow,
  type Journal,
  type Prepared,
  type Runtime,
  atomicJson,
  durableAppend,
  hashes,
  json,
  jsonl,
  journaled,
  loadRuntime,
  nativeCalls,
  outputs,
  validate,
  validateRetrieval,
} from "./hosted-answer-runtime-base.mts";
export type {
  CloudContext,
  HostedCallFactory,
  HostedOptions,
  HostedRow,
} from "./hosted-answer-runtime-base.mts";
export { modelCallOptions } from "./hosted-answer-runtime-base.mts";

function runnerHashes(rt: Runtime) {
  return Object.fromEntries(
    [
      "evaluate-hosted-answers.mts",
      "hosted-answer-runtime.mts",
      "hosted-answer-runtime-base.mts",
    ].map((name) => {
      const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
      return [name, rt.sha256(readFileSync(path))];
    }),
  );
}

export async function evaluateOne(
  context: CloudContext,
  item: Prepared,
  rt: Runtime,
  factory: HostedCallFactory,
  callPath: string,
): Promise<HostedRow> {
  const answerPrompt = rt.answerPrompt(item, context.context);
  const row: HostedRow = {
    question_id: context.question_id,
    question_type: item.question_type,
    context_sha256: context.context_sha256,
    policy_sha256: rt.sha256(context.policy),
    source_content_sha256: context.source_content_sha256,
    answer_prompt_sha256: rt.sha256(answerPrompt),
    premise_prompt_sha256: null,
    judge_prompt_sha256: null,
    answer_call: null,
    failed_answer_call: null,
    answer_recovered: null,
    premise_call: null,
    premise_recorded: null,
    premise_override: false,
    judge_call: null,
    answer: null,
    correct: null,
    error: null,
  };
  const calls = factory(context.policy, rt);
  const answer = rt.withTransportRetry(
    journaled(row.question_id, callPath, calls.answer, rt),
  );
  const judge = rt.withTransportRetry(
    journaled(row.question_id, callPath, calls.judge, rt),
  );
  const result = await rt.answerOnce(
    answer,
    answerPrompt,
    item.question,
    "longer-timeout-transport",
  );
  row.answer_call = result.answerCall;
  row.failed_answer_call = result.failed;
  row.answer_recovered = result.recovered ?? null;
  if (row.answer_call.error) {
    row.error = `answer_${row.answer_call.error}`;
    return row;
  }
  row.answer = rt.parseAnswer(row.answer_call.text);
  if (!row.answer) {
    row.error = "malformed_answer";
    return row;
  }
  const premise = rt.premiseCheckPrompt(
    item.question,
    rt.answerGenerationClock(item.answer_prompt_prefix),
    context.context,
  );
  row.premise_prompt_sha256 = rt.sha256(premise);
  row.premise_call = await answer("premise", premise);
  const check = row.premise_call.error
    ? null
    : rt.parseObject(row.premise_call.text);
  row.premise_recorded =
    typeof check?.correct === "boolean" ? check.correct : null;
  if (row.premise_recorded === false) {
    row.answer = rt.premiseAbstention(
      typeof check?.reason === "string" ? check.reason : "",
    );
    row.premise_override = true;
  }
  const verdict = rt.judgePrompt(item, row.answer);
  row.judge_prompt_sha256 = rt.sha256(verdict);
  row.judge_call = await judge("judge", verdict);
  if (row.judge_call.error) {
    row.error = `judge_${row.judge_call.error}`;
    return row;
  }
  row.correct = rt.parseJudge(row.judge_call.text);
  if (row.correct === null) row.error = "malformed_judge";
  return row;
}

function summary(rows: HostedRow[], planned: number) {
  const scored = rows.filter((row) => typeof row.correct === "boolean"),
    correct = scored.filter((row) => row.correct).length;
  return {
    planned,
    recorded: rows.length,
    scored: scored.length,
    correct,
    accuracy: scored.length ? correct / planned : null,
    errors: rows.filter((row) => row.error).length,
  };
}
function safeResume(
  files: ReturnType<typeof outputs>,
  rows: HostedRow[],
  hashesAtStart: unknown,
  ids: string[],
) {
  const old = json<{ hashes?: unknown; selected_question_ids?: unknown }>(
    files.report,
  ).value;
  if (
    JSON.stringify(old.hashes) !== JSON.stringify(hashesAtStart) ||
    JSON.stringify(old.selected_question_ids) !== JSON.stringify(ids)
  )
    throw new Error("Resume provenance differs");
  const input = new Map(ids.map((id) => [id, true]));
  const done = new Set<string>();
  for (const row of rows) {
    if (done.has(row.question_id) || !input.has(row.question_id))
      throw new Error("Resume rows have duplicate or foreign question IDs");
    done.add(row.question_id);
  }
  const pending = new Set(
    jsonl<Journal>(files.calls).rows.flatMap((entry) =>
      entry.event === "started" && !done.has(entry.question_id)
        ? [entry.question_id]
        : [],
    ),
  );
  if (pending.size)
    throw new Error(
      `Refusing to repeat uncertain started calls: ${[...pending].join(", ")}`,
    );
}

export async function evaluateHostedAnswers(
  options: HostedOptions,
  factory: HostedCallFactory = nativeCalls,
) {
  if (!options.sourceRoot) throw new Error("--source-root is required");
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
    throw new Error("Concurrency must be 1 through 3");
  const root = realpathSync(options.sourceRoot),
    rt = await loadRuntime(root),
    contexts = jsonl<CloudContext>(options.contexts),
    prepared = json<{ cases: Prepared[] }>(options.prepared),
    retrieval = json<Record<string, unknown>>(options.retrievalReport),
    byId = validate(contexts.rows, prepared.value.cases, rt),
    files = outputs(options.out);
  validateRetrieval(contexts.rows, retrieval.value);
  const hashStart = {
    contexts: rt.sha256(contexts.bytes),
    prepared: rt.sha256(prepared.bytes),
    retrieval_report: rt.sha256(retrieval.bytes),
    imported_helpers: hashes(root, rt.sha256),
    runner: runnerHashes(rt),
  };
  const fresh = !options.resume && !Object.values(files).some(existsSync);
  if (!fresh && !options.resume)
    throw new Error("Output already exists; use --resume");
  if (options.resume && !Object.values(files).every(existsSync))
    throw new Error("Cannot resume incomplete outputs");
  const prior = options.resume ? jsonl<HostedRow>(files.rows).rows : [];
  const inputById = new Map(
    contexts.rows.map((context) => [context.question_id, context]),
  );
  if (
    new Set(prior.map((row) => row.question_id)).size !== prior.length ||
    prior.some(
      (row) =>
        inputById.get(row.question_id)?.context_sha256 !== row.context_sha256,
    )
  ) {
    throw new Error("Resume rows do not match the pinned Cloud contexts");
  }
  if (options.resume)
    safeResume(
      files,
      prior,
      hashStart,
      contexts.rows.map((row) => row.question_id),
    );
  const done = new Map(prior.map((row) => [row.question_id, row]));
  const report = {
    status: options.dryRun ? "prepared" : "partial",
    started_at: new Date().toISOString(),
    finished_at: null as string | null,
    invocation: {
      contexts: options.contexts,
      prepared: options.prepared,
      retrieval_report: options.retrievalReport,
      source_root: root,
      concurrency,
      dry_run: !!options.dryRun,
    },
    hashes: hashStart,
    protocol: {
      answer: {
        reasoning: "adaptive",
        max_output_tokens: 16_384,
        system_policy: "actual Cloud policy plus frozen minimal answer policy",
      },
      premise: {
        reasoning: "low",
        max_output_tokens: 4096,
        evidence: "raw Cloud context",
      },
      judge: { reasoning: "none", max_output_tokens: 4096 },
      recovery: "longer-timeout-transport",
    },
    selected_question_ids: contexts.rows.map((row) => row.question_id),
    results: prior,
    summary: summary(prior, contexts.rows.length),
  };
  if (fresh) {
    atomicJson(files.report, report);
    writeFileSync(files.rows, "", { flag: "wx" });
    writeFileSync(files.calls, "", { flag: "wx" });
    atomicJson(files.progress, { status: report.status, completed: 0 });
  }
  if (options.dryRun) {
    report.finished_at = new Date().toISOString();
    atomicJson(files.report, report);
    return report;
  }
  let cursor = 0,
    failure: unknown = null;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!failure) {
        const context = contexts.rows[cursor++];
        if (!context) return;
        if (done.has(context.question_id)) continue;
        try {
          const row = await evaluateOne(
            context,
            byId.get(context.question_id)!,
            rt,
            factory,
            files.calls,
          );
          done.set(row.question_id, row);
          durableAppend(files.rows, row);
          report.results = contexts.rows.flatMap((item) =>
            done.has(item.question_id) ? [done.get(item.question_id)!] : [],
          );
          report.summary = summary(report.results, contexts.rows.length);
          atomicJson(files.progress, {
            status: "partial",
            completed: report.results.length,
          });
          atomicJson(files.report, report);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  report.results = contexts.rows.flatMap((row) =>
    done.has(row.question_id) ? [done.get(row.question_id)!] : [],
  );
  report.summary = summary(report.results, contexts.rows.length);
  const hashEnd = {
    contexts: rt.sha256(readFileSync(options.contexts)),
    prepared: rt.sha256(readFileSync(options.prepared)),
    retrieval_report: rt.sha256(readFileSync(options.retrievalReport)),
    imported_helpers: hashes(root, rt.sha256),
    runner: runnerHashes(rt),
  };
  if (
    JSON.stringify(hashEnd) !==
    JSON.stringify({
      contexts: hashStart.contexts,
      prepared: hashStart.prepared,
      retrieval_report: hashStart.retrieval_report,
      imported_helpers: hashStart.imported_helpers,
      runner: hashStart.runner,
    })
  )
    failure ??= new Error(
      "Inputs or imported runtime changed during evaluation",
    );
  report.status =
    failure || report.results.length !== contexts.rows.length
      ? "partial"
      : "complete";
  report.finished_at = new Date().toISOString();
  atomicJson(files.progress, {
    status: report.status,
    completed: report.results.length,
  });
  atomicJson(files.report, { ...report, hashes_end: hashEnd });
  if (failure) throw failure;
  return report;
}

export function parseHostedArgs(args: string[]): HostedOptions {
  const out: Partial<HostedOptions> = {
    concurrency: 3,
    dryRun: false,
    resume: false,
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (key === "--resume") {
      out.resume = true;
      continue;
    }
    const value = args[++i];
    if (!value) throw new Error("Unknown or missing argument");
    if (key === "--contexts") out.contexts = value;
    else if (key === "--prepared") out.prepared = value;
    else if (key === "--retrieval-report") out.retrievalReport = value;
    else if (key === "--source-root") out.sourceRoot = value;
    else if (key === "--out") out.out = value;
    else if (key === "--concurrency") out.concurrency = Number(value);
    else throw new Error("Unknown argument");
  }
  if (
    !out.contexts ||
    !out.prepared ||
    !out.retrievalReport ||
    !out.sourceRoot ||
    !out.out
  )
    throw new Error(
      "--contexts, --prepared, --retrieval-report, --source-root and --out are required",
    );
  return out as HostedOptions;
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  evaluateHostedAnswers(parseHostedArgs(process.argv.slice(2)))
    .then((report) => {
      if (!report.invocation.dry_run && report.status !== "complete")
        process.exitCode = 1;
    })
    .catch(() => {
      process.exitCode = 1;
    });
