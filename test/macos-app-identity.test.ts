import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  associatedBundleIdentifiers,
  findRecallAppIdentity,
  launchdPlistIdentity,
  readRecallBundleIdentifier,
  RECALL_APP_BUNDLE_IDENTIFIER,
} from "../src/daemon/macos-app-identity.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recall app identity "));
  const app = join(root, "Recall Test.app");
  const runtime = join(app, "Contents", "Resources", "Runtime");
  const node = join(runtime, "bin", "node");
  const daemon = join(runtime, "dist", "daemon.js");
  mkdirSync(join(runtime, "bin"), { recursive: true });
  mkdirSync(join(runtime, "dist"), { recursive: true });
  writeFileSync(node, "node");
  writeFileSync(daemon, "daemon");
  writeFileSync(join(app, "Contents", "Info.plist"), "fixture");
  return { root, app, runtime, node, daemon };
}

describe("Recall macOS app identity", () => {
  it("associates canonical runtime paths, including an app path with spaces", () => {
    const paths = fixture();
    expect(findRecallAppIdentity(paths.node, paths.daemon, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toMatchObject({
      appPath: realpathSync(paths.app),
      runtimePath: realpathSync(paths.runtime),
    });
  });

  it("accepts symlinked inputs only when their canonical targets remain in the same runtime", () => {
    const paths = fixture();
    const nodeLink = join(paths.root, "linked node");
    symlinkSync(paths.node, nodeLink);
    expect(findRecallAppIdentity(nodeLink, paths.daemon, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toBeDefined();

    const external = join(paths.root, "external-daemon.js");
    writeFileSync(external, "daemon");
    const daemonLink = join(paths.runtime, "dist", "custom-daemon.js");
    symlinkSync(external, daemonLink);
    expect(findRecallAppIdentity(paths.node, daemonLink, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toBeUndefined();

    const customRuntimeScript = join(paths.runtime, "dist", "custom-daemon.js");
    writeFileSync(customRuntimeScript, "daemon");
    expect(findRecallAppIdentity(paths.node, customRuntimeScript, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toBeUndefined();
  });

  it("rejects the wrong bundle ID and a custom runtime node", () => {
    const paths = fixture();
    expect(findRecallAppIdentity(paths.node, paths.daemon, {
      readBundleIdentifier: () => "com.example.other",
    })).toBeUndefined();

    const customNode = join(paths.runtime, "custom", "node");
    mkdirSync(join(paths.runtime, "custom"));
    writeFileSync(customNode, "node");
    expect(findRecallAppIdentity(customNode, paths.daemon, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toBeUndefined();
  });

  it("adds only the app association while preserving custom plist content", () => {
    const before = {
      Label: "com.example.custom-recall",
      EnvironmentVariables: { CUSTOM: "preserve-me" },
      KeepAlive: { SuccessfulExit: false },
      AssociatedBundleIdentifiers: ["com.example.host"],
    };
    const after = {
      ...before,
      AssociatedBundleIdentifiers: associatedBundleIdentifiers(before.AssociatedBundleIdentifiers),
    };
    expect(after).toMatchObject({
      Label: "com.example.custom-recall",
      EnvironmentVariables: { CUSTOM: "preserve-me" },
      KeepAlive: { SuccessfulExit: false },
      AssociatedBundleIdentifiers: ["com.example.host", RECALL_APP_BUNDLE_IDENTIFIER],
    });
  });

  it("normalizes a scalar association without losing its unrelated bundle ID", () => {
    expect(associatedBundleIdentifiers("com.example.host")).toEqual([
      "com.example.host",
      RECALL_APP_BUNDLE_IDENTIFIER,
    ]);
    expect(associatedBundleIdentifiers(RECALL_APP_BUNDLE_IDENTIFIER)).toEqual([
      RECALL_APP_BUNDLE_IDENTIFIER,
    ]);
  });

  it("uses Program as launchd's executable and preserves the actual association key state", () => {
    const paths = fixture();
    const externalProgram = join(paths.root, "external", "bin", "node");
    mkdirSync(join(paths.root, "external", "bin"), { recursive: true });
    writeFileSync(externalProgram, "node");
    expect(launchdPlistIdentity({
      Label: "com.example.custom-recall",
      Program: externalProgram,
      ProgramArguments: [paths.node, paths.daemon],
      AssociatedBundleIdentifiers: "com.example.host",
    })).toEqual({
      label: "com.example.custom-recall",
      nodePath: externalProgram,
      daemonScript: paths.daemon,
      associatedBundleIdentifiers: "com.example.host",
      hasAssociatedBundleIdentifiers: true,
    });
    expect(findRecallAppIdentity(externalProgram, paths.daemon, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toBeUndefined();
    expect(launchdPlistIdentity({ ProgramArguments: [paths.node, paths.daemon] }))
      .toMatchObject({ nodePath: paths.node, hasAssociatedBundleIdentifiers: false });
    expect(launchdPlistIdentity({
      Program: { not: "an executable" },
      ProgramArguments: [paths.node, paths.daemon],
    }).nodePath).toBeUndefined();
  });

  it("requires a string bundle ID rather than flattening a malformed plist value", () => {
    const commands: string[][] = [];
    expect(readRecallBundleIdentifier("/fixture/Info.plist", (args) => {
      commands.push(args);
      throw new Error("expected a string, got dictionary");
    })).toBeUndefined();
    expect(commands).toEqual([[
      "-extract", "CFBundleIdentifier", "raw", "-expect", "string", "-o", "-", "/fixture/Info.plist",
    ]]);
  });

  it("uses canonical paths rather than a string prefix", () => {
    const paths = fixture();
    const escaping = join(paths.app, "Contents", "Resources", "Runtime-escape", "daemon.js");
    mkdirSync(join(paths.app, "Contents", "Resources", "Runtime-escape"));
    writeFileSync(escaping, "daemon");
    expect(realpathSync(escaping)).not.toContain(`${paths.runtime}/`);
    expect(findRecallAppIdentity(paths.node, escaping, {
      readBundleIdentifier: () => RECALL_APP_BUNDLE_IDENTIFIER,
    })).toBeUndefined();
  });
});
