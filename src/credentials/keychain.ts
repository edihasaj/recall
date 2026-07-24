import { execFileSync } from "node:child_process";
import { normalizeAzureOpenAiEndpoint } from "../security/outbound-url.js";

export type LlmProvider = "openai" | "anthropic" | "azure-openai";

const KEYCHAIN_SERVICE = "com.recall.llm";

export interface AzureOpenAiConfig {
  provider: "azure-openai";
  endpoint: string;
  deployment: string;
  api_version: string;
  key: string;
}

export interface SimpleProviderConfig {
  provider: "openai" | "anthropic";
  key: string;
}

export type ProviderConfig = SimpleProviderConfig | AzureOpenAiConfig;

export interface StoredCredential {
  provider: LlmProvider;
  source: "keychain" | "env";
  preview: string;
  detail?: string;
}

const SIMPLE_ENV_FALLBACK: Record<"openai" | "anthropic", string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function getApiKey(provider: "openai" | "anthropic"): string | null {
  const cfg = getProviderConfig(provider);
  return cfg ? cfg.key : null;
}

export function getProviderConfig(provider: LlmProvider): ProviderConfig | null {
  if (provider === "azure-openai") return readAzureConfig();
  const key = readSimpleKey(provider);
  return key ? { provider, key } : null;
}

export function hasProviderConfigured(provider: LlmProvider): boolean {
  return getProviderConfig(provider) != null;
}

export function setApiKey(provider: "openai" | "anthropic", key: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "Keychain storage is only supported on macOS. Set the " +
        `${SIMPLE_ENV_FALLBACK[provider]} environment variable instead.`,
    );
  }
  if (!key || key.trim().length === 0) {
    throw new Error("Refusing to store an empty API key");
  }
  writeKeychain(provider, key.trim());
}

export function setAzureConfig(config: {
  endpoint: string;
  deployment: string;
  api_version: string;
  key: string;
}): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "Keychain storage is only supported on macOS. Set the AZURE_OPENAI_* env vars instead.",
    );
  }
  const normalized = {
    endpoint: normalizeAzureOpenAiEndpoint(config.endpoint),
    deployment: config.deployment.trim(),
    api_version: config.api_version.trim(),
    key: config.key.trim(),
  };
  if (!normalized.deployment) throw new Error("Azure deployment name is required");
  if (!normalized.api_version) throw new Error("Azure api_version is required (e.g. 2024-10-21)");
  if (!normalized.key) throw new Error("Azure api key is required");
  writeKeychain("azure-openai", JSON.stringify(normalized));
}

export function deleteApiKey(provider: LlmProvider): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export function listCredentials(): StoredCredential[] {
  const results: StoredCredential[] = [];
  for (const provider of ["openai", "anthropic"] as const) {
    const fromChain = process.platform === "darwin" ? readSimpleKeychain(provider) : null;
    if (fromChain) {
      results.push({ provider, source: "keychain", preview: previewKey(fromChain) });
      continue;
    }
    const fromEnv = process.env[SIMPLE_ENV_FALLBACK[provider]];
    if (fromEnv && fromEnv.trim().length > 0) {
      results.push({ provider, source: "env", preview: previewKey(fromEnv) });
    }
  }
  const azure = readAzureConfig();
  if (azure) {
    results.push({
      provider: "azure-openai",
      source: azureSource(),
      preview: previewKey(azure.key),
      detail: `${azure.endpoint} · ${azure.deployment} · api-version=${azure.api_version}`,
    });
  }
  return results;
}

function readSimpleKey(provider: "openai" | "anthropic"): string | null {
  if (process.platform === "darwin") {
    const fromChain = readSimpleKeychain(provider);
    if (fromChain) return fromChain;
  }
  const fromEnv = process.env[SIMPLE_ENV_FALLBACK[provider]];
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}

function readSimpleKeychain(provider: "openai" | "anthropic"): string | null {
  try {
    const output = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function readAzureConfig(): AzureOpenAiConfig | null {
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "azure-openai", "-w"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const parsed = JSON.parse(trimmed) as Omit<AzureOpenAiConfig, "provider">;
        if (parsed.endpoint && parsed.deployment && parsed.api_version && parsed.key) {
          return {
            provider: "azure-openai",
            ...parsed,
            endpoint: normalizeAzureOpenAiEndpoint(parsed.endpoint),
          };
        }
      }
    } catch {
      // fall through to env
    }
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
  const api_version = process.env.AZURE_OPENAI_API_VERSION?.trim();
  const key = process.env.AZURE_OPENAI_API_KEY?.trim();
  if (endpoint && deployment && api_version && key) {
    try {
      return {
        provider: "azure-openai",
        endpoint: normalizeAzureOpenAiEndpoint(endpoint),
        deployment,
        api_version,
        key,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function azureSource(): "keychain" | "env" {
  if (process.platform !== "darwin") return "env";
  try {
    execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "azure-openai", "-w"],
      { stdio: "ignore" },
    );
    return "keychain";
  } catch {
    return "env";
  }
}

function writeKeychain(provider: LlmProvider, value: string): void {
  // -U updates in place when an entry already exists.
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", provider,
      "-w", value,
      "-T", "",
    ],
    { stdio: "ignore" },
  );
}

function previewKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
