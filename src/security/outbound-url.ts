import { isIP } from "node:net";

const BLOCKED_SYNC_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
]);

const BLOCKED_SYNC_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
  ".home.arpa",
];

interface NormalizeOptions {
  allowPath?: boolean;
  allowedHostSuffixes?: string[];
  blockPrivateNames?: boolean;
}

export function normalizeHttpsBaseUrl(
  raw: string,
  label: string,
  options: NormalizeOptions = {},
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain a query or fragment`);
  }
  if (url.port && url.port !== "443") {
    throw new Error(`${label} must use the default HTTPS port`);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (options.allowedHostSuffixes?.length) {
    const allowed = options.allowedHostSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (!allowed) {
      throw new Error(`${label} host is not supported`);
    }
  }

  if (options.blockPrivateNames) {
    const ipCandidate = hostname.replace(/^\[|\]$/g, "");
    if (
      isIP(ipCandidate) !== 0 ||
      BLOCKED_SYNC_HOSTS.has(hostname) ||
      BLOCKED_SYNC_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    ) {
      throw new Error(`${label} must use a public DNS hostname`);
    }
  }

  if (!options.allowPath && url.pathname !== "/") {
    throw new Error(`${label} must not contain a path`);
  }

  url.hostname = hostname;
  url.pathname = options.allowPath
    ? url.pathname.replace(/\/+$/, "")
    : "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeAzureOpenAiEndpoint(raw: string): string {
  return normalizeHttpsBaseUrl(raw, "Azure endpoint", {
    allowedHostSuffixes: ["openai.azure.com"],
  });
}

export function normalizeSyncRemoteUrl(raw: string): string {
  return normalizeHttpsBaseUrl(raw, "Sync URL", {
    allowPath: true,
    blockPrivateNames: true,
  });
}
