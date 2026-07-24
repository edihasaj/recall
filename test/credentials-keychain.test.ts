import { afterEach, describe, expect, it } from "vitest";

// We import lazily after mutating the environment so the module picks up changes.
async function loadModule() {
  const mod = await import("../src/credentials/keychain.js");
  return mod;
}

const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    process.env[key] = value;
  }
});

describe("keychain credential helper — env fallback", () => {
  it("reads from OPENAI_API_KEY env var when Keychain is absent", async () => {
    // Neutralize the security binary so readKeychain returns null:
    process.env.PATH = "/nonexistent";
    process.env.OPENAI_API_KEY = "sk-test-openai";
    delete process.env.ANTHROPIC_API_KEY;
    const { getApiKey, listCredentials } = await loadModule();
    expect(getApiKey("openai")).toBe("sk-test-openai");
    expect(getApiKey("anthropic")).toBeNull();
    const creds = listCredentials();
    expect(creds).toHaveLength(1);
    expect(creds[0].provider).toBe("openai");
    expect(creds[0].source).toBe("env");
    expect(creds[0].preview).toBe("[configured]");
  });

  it("never exposes key fragments in previews", async () => {
    process.env.PATH = "/nonexistent";
    process.env.OPENAI_API_KEY = "abcd";
    const { listCredentials } = await loadModule();
    const preview = listCredentials().find((c) => c.provider === "openai")?.preview;
    expect(preview).toBe("[configured]");
  });

  it("returns both providers when both env vars are set", async () => {
    process.env.PATH = "/nonexistent";
    process.env.OPENAI_API_KEY = "sk-openai-123456789";
    process.env.ANTHROPIC_API_KEY = "sk-ant-987654321";
    const { listCredentials } = await loadModule();
    const creds = listCredentials();
    expect(creds.map((c) => c.provider).sort()).toEqual(["anthropic", "openai"]);
  });
});
