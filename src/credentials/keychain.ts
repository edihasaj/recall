import { execFileSync } from "node:child_process";

export type LlmProvider = "openai" | "anthropic";

const KEYCHAIN_SERVICE = "com.recall.llm";
const ENV_FALLBACK: Record<LlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export interface StoredCredential {
  provider: LlmProvider;
  source: "keychain" | "env";
  preview: string;
}

export function getApiKey(provider: LlmProvider): string | null {
  if (process.platform === "darwin") {
    const keyFromChain = readKeychain(provider);
    if (keyFromChain) return keyFromChain;
  }
  const fromEnv = process.env[ENV_FALLBACK[provider]];
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}

export function setApiKey(provider: LlmProvider, key: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "Keychain storage is only supported on macOS. Set the " +
        `${ENV_FALLBACK[provider]} environment variable instead.`,
    );
  }
  if (!key || key.trim().length === 0) {
    throw new Error("Refusing to store an empty API key");
  }
  writeKeychain(provider, key.trim());
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
  for (const provider of ["openai", "anthropic"] as LlmProvider[]) {
    const fromChain = process.platform === "darwin" ? readKeychain(provider) : null;
    if (fromChain) {
      results.push({ provider, source: "keychain", preview: previewKey(fromChain) });
      continue;
    }
    const fromEnv = process.env[ENV_FALLBACK[provider]];
    if (fromEnv && fromEnv.trim().length > 0) {
      results.push({ provider, source: "env", preview: previewKey(fromEnv) });
    }
  }
  return results;
}

function readKeychain(provider: LlmProvider): string | null {
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

function writeKeychain(provider: LlmProvider, key: string): void {
  // -U updates in place when an entry already exists.
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", provider,
      "-w", key,
      "-T", "", // no app auto-access — user still sees Keychain prompts on first read
    ],
    { stdio: "ignore" },
  );
}

function previewKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
