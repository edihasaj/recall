import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHome, makeService, TOKEN } from "./helpers/cloud-fakes.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
function setup() {
  const h = makeHome();
  homes.push(h.home);
  return { ...h, ...makeService(h.env) };
}

describe("explicit Cloud privacy modes", () => {
  it("requires a key before enabling private sync and changes nothing on failure", async () => {
    const { service, worker } = setup();
    await expect(service.connect({ token: TOKEN, optIn: true, privacyMode: "private" }))
      .rejects.toMatchObject({ code: "encryption-required" });
    expect(service.status().enabled).toBe(false);
    expect(worker.launches).toHaveLength(0);
  });

  it("private sync disables Cloud questions and never exposes the key in status", async () => {
    const { service, paths } = setup();
    const key = "test-only original recovery phrase";
    const status = await service.connect({ token: TOKEN, optIn: true, privacyMode: "private", e2eePassphrase: key });
    expect(status.config).toMatchObject({ e2ee: true, queryEnrichment: false });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(readFileSync(paths.configFile, "utf8")).not.toContain(key);
    await expect(service.setQueryEnrichment(true)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("keeps searchable sync available as an explicit option", async () => {
    const { service, worker } = setup();
    const status = await service.connect({ token: TOKEN, optIn: true, privacyMode: "searchable" });
    expect(status.config).toMatchObject({ e2ee: false, queryEnrichment: true });
    expect(worker.launches[0].args).not.toContain("--e2ee");
  });

  it("rejects changing a saved key or downgrading an encrypted device before stopping it", async () => {
    const { service, worker } = setup();
    await service.connect({ token: TOKEN, optIn: true, privacyMode: "private", e2eePassphrase: "original" });
    for (const input of [{ privacyMode: "searchable" }, { e2eePassphrase: "different" }, { privacyMode: "unknown" }]) {
      await expect(service.connect({ token: TOKEN, optIn: true, ...input })).rejects.toBeDefined();
      expect(worker.launches).toHaveLength(1);
      expect(service.status().enabled).toBe(true);
    }
    await service.connect({ token: TOKEN, optIn: true, privacyMode: "private" });
    expect(worker.launches.at(-1)?.env.RECALL_CLOUD_E2EE_PASSPHRASE).toBe("original");
  });
});
