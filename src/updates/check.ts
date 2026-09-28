const RELEASE_API = "https://api.github.com/repos/edihasaj/recall/releases/latest";
const READY_FOR_INSTALL = [
  "Recall.app.zip",
  "Recall.app.zip.sha256",
  "recall-tray-amd64.exe",
  "recall-tray-arm64.exe",
  "Recall-Install.ps1",
] as const;
const READY_TTL_MS = 30 * 60 * 1000;
const RETRY_TTL_MS = 5 * 60 * 1000;
const FORCE_FLOOR_MS = 60 * 1000;

export interface UpdateReport {
  current_version: string;
  latest_version: string | null;
  available: boolean;
  ready: boolean;
  release_url: string | null;
  installer_sha256: string | null;
  checked_at: string | null;
  error?: string;
}

interface ReleaseInfo {
  version: string;
  ready: boolean;
  installerSha256: string | null;
  checkedAt: string;
}

export function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) return null;
    const numbers = match.slice(1).map(Number);
    return numbers.every(Number.isSafeInteger) ? numbers : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
}

export class ReleaseChecker {
  private cached: ReleaseInfo | null = null;
  private checkedAtMs = 0;
  private expiresAtMs = 0;
  private pending: Promise<ReleaseInfo> | null = null;

  constructor(
    private readonly fetchRelease: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async check(currentVersion: string, force = false): Promise<UpdateReport> {
    const now = this.now();
    const canRefresh = !force || now - this.checkedAtMs >= FORCE_FLOOR_MS;
    if ((now >= this.expiresAtMs || (force && canRefresh)) && !this.pending) {
      this.pending = this.load();
    }
    if (this.pending) {
      try {
        this.cached = await this.pending;
        this.checkedAtMs = this.now();
        this.expiresAtMs = this.checkedAtMs + (this.cached.ready ? READY_TTL_MS : RETRY_TTL_MS);
      } catch {
        this.checkedAtMs = this.now();
        this.expiresAtMs = this.checkedAtMs + RETRY_TTL_MS;
        if (!this.cached) return this.report(currentVersion, "Could not check for updates");
      } finally {
        this.pending = null;
      }
    }
    return this.report(currentVersion);
  }

  private report(currentVersion: string, error?: string): UpdateReport {
    const latest = this.cached;
    const newer = latest ? compareVersions(latest.version, currentVersion) === 1 : false;
    return {
      current_version: currentVersion,
      latest_version: latest?.version ?? null,
      available: Boolean(latest?.ready && newer),
      ready: latest?.ready ?? false,
      release_url: latest ? `https://github.com/edihasaj/recall/releases/tag/v${latest.version}` : null,
      installer_sha256: latest?.installerSha256 ?? null,
      checked_at: latest?.checkedAt ?? null,
      ...(error ? { error } : {}),
    };
  }

  private async load(): Promise<ReleaseInfo> {
    const response = await this.fetchRelease(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "recall-update-check",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`release API returned ${response.status}`);
    const raw = await response.json() as Record<string, unknown>;
    const tag = typeof raw.tag_name === "string" ? raw.tag_name : "";
    if (raw.draft || raw.prerelease || !/^v\d+\.\d+\.\d+$/.test(tag)) {
      throw new Error("latest release has no stable version");
    }
    const version = tag.slice(1);
    const uploaded =
      (Array.isArray(raw.assets) ? raw.assets : [])
        .filter((asset): asset is { name: string; state: string; digest?: string } =>
          typeof asset === "object" && asset !== null &&
          typeof asset.name === "string" && asset.state === "uploaded");
    const assets = new Set(uploaded.map((asset) => asset.name));
    const installer = uploaded.find((asset) => asset.name === "Recall-Install.ps1");
    const installerDigest = /^sha256:([a-fA-F0-9]{64})$/.exec(installer?.digest ?? "");
    const ready = [...READY_FOR_INSTALL,
      `edihasaj-recall-${version}.tgz`,
      `edihasaj-recall-${version}.tgz.sha256`,
    ].every((name) => assets.has(name)) && installerDigest !== null;
    return {
      version,
      ready,
      installerSha256: installerDigest?.[1]?.toLowerCase() ?? null,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

export const releaseChecker = new ReleaseChecker();
