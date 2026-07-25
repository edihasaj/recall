import { describe, expect, it } from "vitest";
import {
  readDaemonProviderEnvironment,
  resolveDaemonProviderEnvironment,
} from "../src/daemon/provider-env.js";
import { parseSystemdEnvironment } from "../src/daemon/systemd.js";

describe("daemon provider environment", () => {
  it("passes configured provider credentials to a service", () => {
    expect(resolveDaemonProviderEnvironment({
      OPENAI_API_KEY: "openai-key",
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_API_KEY: "azure-key",
      UNRELATED_SECRET: "never-copy",
    })).toEqual({
      OPENAI_API_KEY: "openai-key",
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_API_KEY: "azure-key",
    });
  });

  it("preserves installed credentials unless the current environment replaces them", () => {
    expect(resolveDaemonProviderEnvironment(
      { AZURE_OPENAI_API_KEY: "new-key" },
      {
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        AZURE_OPENAI_API_KEY: "old-key",
      },
    )).toEqual({
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_API_KEY: "new-key",
    });
  });

  it("reads only non-empty provider variables from an installed service", () => {
    expect(readDaemonProviderEnvironment({
      ANTHROPIC_API_KEY: "anthropic-key",
      AZURE_OPENAI_API_KEY: "",
      PATH: "/usr/bin",
    })).toEqual({
      ANTHROPIC_API_KEY: "anthropic-key",
    });
  });

  it("reads quoted provider values back from a systemd unit", () => {
    expect(parseSystemdEnvironment([
      "Environment=RECALL_PORT=7890",
      'Environment="AZURE_OPENAI_API_KEY=key%%with\\\"quote\\\\slash"',
    ].join("\n"))).toEqual({
      RECALL_PORT: "7890",
      AZURE_OPENAI_API_KEY: 'key%with"quote\\slash',
    });
  });
});
