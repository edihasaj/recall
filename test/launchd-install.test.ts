import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  commands: [] as Array<{ command: string; args: string[] }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    chmodSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: (path: string) => state.files.has(path),
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    unlinkSync: vi.fn(),
    rmSync: (path: string) => { state.files.delete(path); },
    writeFileSync: (path: string, content: string) => state.files.set(path, content),
  };
});

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => "/test-home",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: (command: string, args: string[]) => {
      state.commands.push({ command, args });
      if (command === "plutil" && args[0] === "-convert") {
        const source = state.files.get(args.at(-1)!);
        if (!source) throw new Error("plist not found");
        return JSON.stringify(plistJson(source));
      }
      if (command === "plutil" && (args[0] === "-insert" || args[0] === "-replace")) {
        return "";
      }
      if (command === "launchctl" && args[0] === "print") return "state = running\n";
      return "";
    },
  };
});

vi.mock("../src/daemon/macos-app-identity.js", () => ({
  associatedBundleIdentifiers: (existing: unknown) => [
    ...(Array.isArray(existing) ? existing : []),
    "com.edihasaj.recall",
  ],
  findRecallAppIdentity: (nodePath: string, daemonScript: string) => (
    nodePath === "/Runtime/bin/node" && daemonScript === "/Runtime/dist/daemon.js"
      ? { bundleIdentifier: "com.edihasaj.recall" }
      : undefined
  ),
  launchdPlistIdentity: (plist: Record<string, unknown>) => ({
    label: typeof plist.Label === "string" ? plist.Label : undefined,
    nodePath: Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments[0] : undefined,
    daemonScript: Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments[1] : undefined,
    associatedBundleIdentifiers: plist.AssociatedBundleIdentifiers,
    hasAssociatedBundleIdentifiers: Object.hasOwn(plist, "AssociatedBundleIdentifiers"),
  }),
}));

import {
  getLaunchAgentInfo,
  getLaunchAgentStatus,
  installLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "../src/daemon/launchd.js";

const plistPath = "/test-home/Library/LaunchAgents/com.example.recall.plist";

beforeEach(() => {
  state.files.clear();
  state.commands.length = 0;
  vi.stubGlobal("process", { ...process, platform: "darwin", getuid: () => 501 });
});

describe("launchd daemon install", () => {
  it("rewrites and reloads an existing plist with the requested effective configuration", () => {
    installLaunchAgent({
      label: "com.example.recall",
      port: 7891,
      dataDir: "/data/first",
      nodePath: "/runtime/first/node",
      daemonScript: "/runtime/first/daemon.js",
      repoRoots: "/repos/first",
    });
    installLaunchAgent({
      label: "com.example.recall",
      port: 7892,
      dataDir: "/data/second",
      nodePath: "/runtime/second/node",
      daemonScript: "/runtime/second/daemon.js",
      repoRoots: "/repos/second",
      embeddingProvider: "nomic",
    });

    expect(plistJson(state.files.get(plistPath)!)).toMatchObject({
      Label: "com.example.recall",
      ProgramArguments: ["/runtime/second/node", "/runtime/second/daemon.js"],
      EnvironmentVariables: {
        RECALL_PORT: "7892",
        RECALL_DATA_DIR: "/data/second",
        RECALL_REPO_ROOTS: "/repos/second",
        RECALL_EMBEDDING_PROVIDER: "nomic",
      },
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["bootout", "gui/501", plistPath],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["bootstrap", "gui/501", plistPath],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["kickstart", "gui/501/com.example.recall"],
    });
  });

  it("migrates only metadata for an existing custom Label without reloading it", () => {
    const customPath = "/test-home/Library/LaunchAgents/com.recall.daemon.plist";
    state.files.set(customPath, plist({
      Label: "com.example.custom-recall",
      ProgramArguments: ["/Runtime/bin/node", "/Runtime/dist/daemon.js"],
      EnvironmentVariables: { CUSTOM: "preserve-me" },
      KeepAlive: { SuccessfulExit: false },
    }));

    // Commander passes the default label even without a --label flag.
    startLaunchAgent("com.recall.daemon");

    expect(state.commands).toContainEqual({
      command: "plutil",
      args: [
        "-insert", "AssociatedBundleIdentifiers", "-xml",
        "<array><string>com.edihasaj.recall</string></array>", customPath,
      ],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["enable", "gui/501/com.example.custom-recall"],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["kickstart", "gui/501/com.example.custom-recall"],
    });
    expect(state.commands).not.toContainEqual({
      command: "launchctl",
      args: ["bootout", "gui/501", customPath],
    });
    expect(state.commands).not.toContainEqual({
      command: "launchctl",
      args: ["bootstrap", "gui/501", customPath],
    });
    expect(state.files.get(customPath)).toContain("preserve-me");
  });

  it("uses the default filename selector and the stored Label for lifecycle commands", () => {
    const defaultLabel = "com.recall.daemon";
    const customLabel = "com.example.custom-recall";
    const defaultPath = `/test-home/Library/LaunchAgents/${defaultLabel}.plist`;
    state.files.set(defaultPath, plist({
      Label: customLabel,
      ProgramArguments: ["/Runtime/bin/node", "/Runtime/dist/daemon.js"],
      EnvironmentVariables: {},
      KeepAlive: { SuccessfulExit: false },
    }));

    startLaunchAgent(defaultLabel);
    stopLaunchAgent(defaultLabel);
    expect(getLaunchAgentStatus(defaultLabel)).toMatchObject({
      label: customLabel,
      plistPath: defaultPath,
    });
    expect(getLaunchAgentInfo(defaultLabel)).toContain(`Plist:      ${defaultPath}`);
    const removed = uninstallLaunchAgent(defaultLabel);

    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["enable", `gui/501/${customLabel}`],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["kickstart", `gui/501/${customLabel}`],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["print", `gui/501/${customLabel}`],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["bootout", "gui/501", defaultPath],
    });
    expect(state.commands).toContainEqual({
      command: "launchctl",
      args: ["disable", `gui/501/${customLabel}`],
    });
    expect(removed).toMatchObject({ label: customLabel, plistPath: defaultPath });
  });
});

function plistJson(source: string): Record<string, unknown> {
  const value = (key: string, content = source) => content.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
  const program = source.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
  const environment = source.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const environmentValues = Object.fromEntries(
    [...environment.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]+)<\/string>/g)]
      .map((match) => [match[1], match[2]]),
  );
  return {
    Label: value("Label"),
    ProgramArguments: [...program.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]),
    EnvironmentVariables: environmentValues,
  };
}

function plist(config: {
  Label: string;
  ProgramArguments: string[];
  EnvironmentVariables: Record<string, string>;
  KeepAlive: unknown;
}): string {
  return `<?xml version="1.0"?><plist><dict>
    <key>Label</key><string>${config.Label}</string>
    <key>ProgramArguments</key><array>${config.ProgramArguments.map((value) => `<string>${value}</string>`).join("")}</array>
    <key>EnvironmentVariables</key><dict>${Object.entries(config.EnvironmentVariables).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("")}</dict>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  </dict></plist>`;
}
