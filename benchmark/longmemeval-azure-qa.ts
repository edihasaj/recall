/** Azure-only LongMemEval answer routing and credential-free configuration. */
import { azureResponsesUrl, createAzureAnswerCall } from "./longmemeval-azure-answer.js";
import type { Call, ModelCall, Provider } from "./longmemeval-qa-support.js";

const ENV_ENDPOINT = "LONGMEMEVAL_AZURE_ENDPOINT";
const ENV_DEPLOYMENT = "LONGMEMEVAL_AZURE_DEPLOYMENT";
const ENV_KEY = "LONGMEMEVAL_AZURE_API_KEY";

export type AzureAnswerHarnessOptions = {
  answerProvider?: "azure";
  provider?: Provider;
  evidence?: string;
  topK: number;
  concurrency: number;
  requestMode?: "standard" | "robust";
  answerCheck?: "none" | "grounded" | "premise";
  reasoningEffort?: "none" | "low" | "medium" | "high" | "adaptive";
  maxOutputTokens?: number;
  evidencePolicy?: "inline" | "system";
  evidenceLedger?: "none" | "quoted" | "units" | "packed";
};

export type AzureAnswerPreparation = {
  endpoint: string;
  deployment: string;
  key?: string;
  metadata: {
    endpoint: string;
    deployment: string;
    answer_reasoning_effort: "medium";
    answer_max_output_tokens: 16384;
    answer_temperature: "unset/providerdefault";
    actual_model_recorded_in: "answer_call.model";
  };
};

/**
 * Validate the fixed Azure-answer experiment without discovering credentials.
 * Endpoint/deployment are safe report metadata; the key is read only when an
 * actual answer call can occur and is never returned in metadata.
 */
export function prepareAzureAnswer(
  options: AzureAnswerHarnessOptions,
  liveCalls: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): AzureAnswerPreparation | null {
  if (options.answerProvider !== "azure") return null;
  if (options.evidence !== "supplemental") throw new Error("Azure answers require supplemental evidence");
  if (options.topK !== 20) throw new Error("Azure answers require --top-k 20");
  if (options.concurrency !== 1) throw new Error("Azure answers require concurrency one");
  if (options.evidenceLedger && options.evidenceLedger !== "none") throw new Error("Azure answers cannot use an evidence ledger");
  if (options.answerCheck === "grounded") throw new Error("Azure answers cannot use grounded answer checks");
  if (options.requestMode !== "robust" || options.evidencePolicy !== "system") {
    throw new Error("Azure answers require robust requests and system evidence policy");
  }
  if (options.reasoningEffort !== "adaptive" || options.maxOutputTokens !== 16_384) {
    throw new Error("Azure answers require adaptive Qwen settings and a 16384-token answer budget");
  }
  if (liveCalls && options.provider !== "qwen-local") throw new Error("Azure answers require qwen-local for judging");

  const configuredEndpoint = environment[ENV_ENDPOINT]?.trim();
  const deployment = environment[ENV_DEPLOYMENT]?.trim();
  if (!configuredEndpoint) throw new Error(`${ENV_ENDPOINT} is required for Azure answer metadata`);
  if (!deployment) throw new Error(`${ENV_DEPLOYMENT} is required for Azure answer metadata`);
  const endpoint = azureResponsesUrl(configuredEndpoint);
  const key = liveCalls ? environment[ENV_KEY]?.trim() : undefined;
  if (liveCalls && !key) throw new Error(`${ENV_KEY} is required for live Azure answers`);

  return {
    endpoint,
    deployment,
    ...(key ? { key } : {}),
    metadata: {
      endpoint,
      deployment,
      answer_reasoning_effort: "medium",
      answer_max_output_tokens: 16_384,
      answer_temperature: "unset/providerdefault",
      actual_model_recorded_in: "answer_call.model",
    },
  };
}

/** Route only generation to Azure; ledgers and the fixed judge remain Qwen. */
export function composeAzureAnswerCall(
  azureAnswer: (prompt: string) => Promise<Call>,
  qwenCall: ModelCall,
): ModelCall {
  return (kind, prompt, meta) => kind === "answer"
    ? azureAnswer(prompt)
    : qwenCall(kind, prompt, meta);
}

export function createAzureComposedCall(
  preparation: AzureAnswerPreparation,
  answerInstructions: string,
  qwenCall: ModelCall,
): ModelCall {
  if (!preparation.key) throw new Error("Azure answer key is required for live calls");
  return composeAzureAnswerCall(createAzureAnswerCall({
    endpoint: preparation.endpoint,
    deployment: preparation.deployment,
    key: preparation.key,
    answerInstructions,
  }), qwenCall);
}
