export const DAEMON_PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_API_KEY",
] as const;

export type DaemonProviderEnvironment = Partial<
  Record<(typeof DAEMON_PROVIDER_ENV_KEYS)[number], string>
>;

export function resolveDaemonProviderEnvironment(
  current: Record<string, string | undefined>,
  installed: DaemonProviderEnvironment = {},
): DaemonProviderEnvironment {
  const resolved: DaemonProviderEnvironment = {};
  for (const key of DAEMON_PROVIDER_ENV_KEYS) {
    const value = current[key] ?? installed[key];
    if (value && value.trim().length > 0) {
      resolved[key] = value;
    }
  }
  return resolved;
}

export function readDaemonProviderEnvironment(
  environment: Record<string, unknown>,
): DaemonProviderEnvironment {
  const installed: DaemonProviderEnvironment = {};
  for (const key of DAEMON_PROVIDER_ENV_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value.trim().length > 0) {
      installed[key] = value;
    }
  }
  return installed;
}
