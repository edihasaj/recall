import { describe, expect, it, vi } from "vitest";
import { compareVersions, ReleaseChecker } from "../src/updates/check.js";

function release(version: string, complete = true) {
  const names = [
    "Recall.app.zip", "Recall.app.zip.sha256",
    "recall-tray-amd64.exe", "recall-tray-arm64.exe", "Recall-Install.ps1",
    `edihasaj-recall-${version}.tgz`, `edihasaj-recall-${version}.tgz.sha256`,
  ];
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: names.slice(0, complete ? names.length : 4).map((name) => ({
      name, state: "uploaded", digest: name === "Recall-Install.ps1" ? `sha256:${"a".repeat(64)}` : null,
    })),
  };
}

describe("desktop update availability", () => {
  it("compares numeric release versions and rejects non-release tags", () => {
    expect(compareVersions("1.4.18", "v1.4.17")).toBe(1);
    expect(compareVersions("1.4.9", "1.4.17")).toBe(-1);
    expect(compareVersions("1.4.17", "v1.4.17")).toBe(0);
    expect(compareVersions("1.4.18-beta.1", "1.4.17")).toBeNull();
  });

  it("waits until every platform asset is uploaded, then caches the ready release", async () => {
    let now = 1_000_000;
    const fetchRelease = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => release("1.4.18", false) })
      .mockResolvedValue({ ok: true, json: async () => release("1.4.18") });
    const checker = new ReleaseChecker(fetchRelease, () => now);
    expect((await checker.check("1.4.17")).available).toBe(false);
    now += 5 * 60 * 1000;
    expect((await checker.check("1.4.17")).available).toBe(true);
    expect((await checker.check("1.4.17")).release_url).toBe(
      "https://github.com/edihasaj/recall/releases/tag/v1.4.18",
    );
    expect((await checker.check("1.4.17")).installer_sha256).toBe("a".repeat(64));
    expect(fetchRelease).toHaveBeenCalledTimes(2);
  });

  it("does not offer an update when the release check fails", async () => {
    const checker = new ReleaseChecker(async () => { throw new Error("offline"); });
    const result = await checker.check("1.4.17");
    expect(result.available).toBe(false);
    expect(result.latest_version).toBeNull();
    expect(result.error).toBe("Could not check for updates");
  });

  it("requires a checksummed installer before offering an update", async () => {
    const incomplete = release("1.4.18");
    incomplete.assets[incomplete.assets.length - 3]!.digest = null;
    const checker = new ReleaseChecker(async () => ({ ok: true, json: async () => incomplete } as Response));
    const result = await checker.check("1.4.17");
    expect(result.ready).toBe(false);
    expect(result.available).toBe(false);
    expect(result.installer_sha256).toBeNull();
  });

  it("limits repeated manual checks while still allowing a fresh check", async () => {
    let now = 1_000_000;
    const fetchRelease = vi.fn().mockResolvedValue({ ok: true, json: async () => release("1.4.18") });
    const checker = new ReleaseChecker(fetchRelease, () => now);
    await checker.check("1.4.17");
    await checker.check("1.4.17", true);
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    now += 60_000;
    await checker.check("1.4.17", true);
    expect(fetchRelease).toHaveBeenCalledTimes(2);
  });
});
