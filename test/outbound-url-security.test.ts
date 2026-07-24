import { describe, expect, it } from "vitest";
import {
  normalizeAzureOpenAiEndpoint,
  normalizeSyncRemoteUrl,
} from "../src/security/outbound-url.js";

describe("outbound URL security", () => {
  it("normalizes official Azure OpenAI endpoints", () => {
    expect(
      normalizeAzureOpenAiEndpoint("https://MyResource.openai.azure.com/"),
    ).toBe("https://myresource.openai.azure.com");
  });

  it.each([
    "http://resource.openai.azure.com",
    "https://resource.openai.azure.com/path",
    "https://resource.openai.azure.com?key=value",
    "https://resource.openai.azure.com.evil.example",
    "https://user:pass@resource.openai.azure.com",
  ])("rejects unsafe Azure endpoint %s", (url) => {
    expect(() => normalizeAzureOpenAiEndpoint(url)).toThrow();
  });

  it("allows canonical public sync hosts and path prefixes", () => {
    expect(normalizeSyncRemoteUrl("https://sync.example.com/v1/")).toBe(
      "https://sync.example.com/v1",
    );
  });

  it.each([
    "http://sync.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://metadata.google.internal",
    "https://sync.example.com:8443",
    "https://sync.example.com/path?next=/",
  ])("rejects unsafe sync URL %s", (url) => {
    expect(() => normalizeSyncRemoteUrl(url)).toThrow();
  });
});
