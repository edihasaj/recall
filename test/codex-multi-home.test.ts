import { describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installCodexHooks,
  resolveCodexHomes,
  resolveCodexHookTargets,
} from "../src/agents/codex.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "codex", "config.toml");

function makeHome() {
  return mkdtempSync(join(tmpdir(), "recall-codex-homes-"));
}

function makeCodexHome(home: string, name: string) {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), readFileSync(fixturePath, "utf-8"));
  return dir;
}

describe("Codex multi-home resolution", () => {
  it("discovers .codex-* profile siblings alongside the default home", () => {
    const home = makeHome();
    makeCodexHome(home, ".codex");
    makeCodexHome(home, ".codex-primary");
    makeCodexHome(home, ".codex-secondary");

    const homes = resolveCodexHomes({ home, env: {} });

    expect(homes).toEqual([
      join(home, ".codex"),
      join(home, ".codex-primary"),
      join(home, ".codex-secondary"),
    ]);
  });

  it("ignores sibling directories that are not Codex homes", () => {
    const home = makeHome();
    makeCodexHome(home, ".codex");
    mkdirSync(join(home, ".codex-empty"), { recursive: true });
    makeCodexHome(home, ".codex-primary.bak");
    mkdirSync(join(home, ".codexbar"), { recursive: true });

    expect(resolveCodexHomes({ home, env: {} })).toEqual([join(home, ".codex")]);
  });

  it("treats an auth-only or sessions-only directory as a Codex home", () => {
    const home = makeHome();
    makeCodexHome(home, ".codex");
    const authOnly = join(home, ".codex-authonly");
    mkdirSync(authOnly, { recursive: true });
    writeFileSync(join(authOnly, "auth.json"), "{}");

    expect(resolveCodexHomes({ home, env: {} })).toContain(authOnly);
  });

  it("uses CODEX_HOME as the primary home when set", () => {
    const home = makeHome();
    makeCodexHome(home, ".codex");
    const custom = makeCodexHome(home, ".codex-primary");

    const homes = resolveCodexHomes({ home, env: { CODEX_HOME: custom } });

    // Primary first, and not duplicated by discovery.
    expect(homes[0]).toBe(custom);
    expect(homes.filter((entry) => entry === custom)).toHaveLength(1);
    expect(homes).not.toContain(join(home, ".codex"));
  });

  it("honours an explicit RECALL_CODEX_HOMES override verbatim", () => {
    const home = makeHome();
    makeCodexHome(home, ".codex");
    const a = makeCodexHome(home, ".codex-primary");
    const b = makeCodexHome(home, ".codex-secondary");

    const homes = resolveCodexHomes({
      home,
      env: { RECALL_CODEX_HOMES: `${a},${b}` },
    });

    expect(homes).toEqual([a, b]);
  });

  it("expands ~ in RECALL_CODEX_HOMES entries", () => {
    const home = makeHome();
    const primary = makeCodexHome(home, ".codex-primary");

    const homes = resolveCodexHomes({
      home,
      env: { RECALL_CODEX_HOMES: "~/.codex-primary" },
    });

    expect(homes).toEqual([primary]);
  });

  it("collapses profiles that share a symlinked config.toml into one target", () => {
    const home = makeHome();
    const shared = makeCodexHome(home, ".codex");
    const linked = join(home, ".codex-secondary");
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(shared, "config.toml"), join(linked, "config.toml"));

    const homes = resolveCodexHomes({ home, env: {} });
    expect(homes).toHaveLength(2);

    // Both homes exist, but they resolve to a single config file to write.
    const targets = resolveCodexHookTargets({ home, env: {} });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.configPath).toBe(join(shared, "config.toml"));
  });

  it("keeps a symlinked config.toml a symlink instead of forking it into a copy", () => {
    const home = makeHome();
    const shared = makeCodexHome(home, ".codex");
    const linked = join(home, ".codex-secondary");
    mkdirSync(linked, { recursive: true });
    const linkedConfig = join(linked, "config.toml");
    symlinkSync(join(shared, "config.toml"), linkedConfig);

    const result = installCodexHooks({
      configPath: linkedConfig,
      hooksPath: join(linked, "hooks.json"),
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/cli.js",
      forceHooks: true,
    });

    expect(result.ok).toBe(true);
    expect(lstatSync(linkedConfig).isSymbolicLink()).toBe(true);
    // The write landed on the shared file, so the other profile sees it too.
    expect(readFileSync(join(shared, "config.toml"), "utf-8")).toContain("codex_hooks");
  });
});
