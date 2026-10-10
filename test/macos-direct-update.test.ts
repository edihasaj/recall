import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const version = "2.0.3";
const suite = process.platform === "win32" ? describe.skip : describe;

function fixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "recall direct update "));
  const app = join(root, "Applications", "Recall.app");
  const incoming = join(root, "incoming", "Recall.app");
  const home = join(root, "home");
  const commands = join(root, "commands");
  const calls = join(root, "calls");
  mkdirSync(commands);
  mkdirSync(join(home, ".recall"), { recursive: true });
  writeFileSync(join(home, ".recall", "recall.db"), "local memories");
  for (const [path, release] of [[app, "2.0.2"], [incoming, version]]) {
    const bin = join(path!, "Contents", "Resources", "Runtime", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(path!, "Contents", "Info.plist"), release!);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "recall"), `#!/bin/bash
if [[ "$1" == --version ]]; then echo ${release}; exit; fi
echo '${release} '"$*" >> "$CALLS"
if [[ '${release}' == '${version}' && "$*" == 'daemon restart' && "$FAIL_RESTART" == 1 ]]; then exit 1; fi
`);
    chmodSync(join(bin, "recall"), 0o700);
  }
  const payload = "release archive";
  const digest = createHash("sha256").update(payload).digest("hex");
  const mock = (name: string, body: string) => {
    const path = join(commands, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  };
  const curl = mock("curl", `
    const fs = require('fs'), args = process.argv.slice(2);
    if (args.includes('http://127.0.0.1:7890/health')) {
      console.log(JSON.stringify({status:'ok', version: process.env.HEALTH_VERSION || fs.readFileSync(process.env.APP + '/Contents/Info.plist','utf8')}));
    } else {
      const output = args[args.indexOf('-o') + 1];
      fs.writeFileSync(output, output.endsWith('.sha256')
        ? (process.env.BAD_CHECKSUM ? '0'.repeat(64) : '${digest}') + '  Recall.app.zip\\n' : '${payload}');
    }
  `);
  const ditto = mock("ditto", `
    require('fs').cpSync(process.env.INCOMING, process.argv.at(-1) + '/Recall.app', {recursive:true});
  `);
  const plist = mock("PlistBuddy", `console.log(require('fs').readFileSync(process.argv.at(-1), 'utf8'));`);
  const codesign = mock("codesign", `
    require('fs').appendFileSync(process.env.CALLS, 'codesign ' + process.argv.slice(2).join(' ') + '\\n');
    if (process.env.BAD_SIGNATURE) process.exit(1);
  `);
  const spctl = mock("spctl", `if (process.env.BAD_NOTARIZATION) process.exit(1);`);
  const open = mock("open", `require('fs').appendFileSync(process.env.CALLS, 'open ' + process.argv.at(-1) + '\\n');`);
  const mv = mock("mv", `
    const args = process.argv.slice(2);
    if (process.env.FAIL_SWAP && args[0].endsWith('/unpacked/Recall.app') && args[1] === process.env.APP) process.exit(1);
    require('child_process').execFileSync('/bin/mv', args);
  `);
  mock("sleep", "");
  let script = readFileSync("scripts/recall-update-direct-macos", "utf8");
  // Substitute OS tools only. The actual helper control flow and filesystem
  // swaps run unchanged against an isolated fake app, never /Applications.
  for (const [from, to] of Object.entries({
    "/usr/bin/curl": curl, "/usr/bin/ditto": ditto, "/usr/libexec/PlistBuddy": plist,
    "/usr/bin/codesign": codesign, "/usr/sbin/spctl": spctl, "/usr/bin/open": open, "/bin/mv": mv,
  })) script = script.replaceAll(from, `"${to}"`);
  const helper = join(root, "helper");
  writeFileSync(helper, script);
  const env = { ...process.env, ...overrides, HOME: home, APP: app, INCOMING: incoming, CALLS: calls,
    PATH: `${commands}:${process.env.PATH}` };
  const run = (mode: string) => spawnSync(process.platform === "darwin" ? "/bin/bash" : "bash", [helper, mode, version, app, "2147483647"], { env, encoding: "utf8" });
  return { root, home, app, incoming, calls, run,
    state: join(home, ".recall", "updates", `direct-stage-${version}`),
    result: join(home, ".recall", "updates", "result") };
}

suite("direct macOS updater", () => {
  it("updates without Homebrew, checks the publisher, preserves memories, and reopens", () => {
    const f = fixture();
    expect(f.run("prepare").status).toBe(0);
    const stage = readFileSync(f.state, "utf8").trim();
    expect(readFileSync(join(f.app, "Contents", "Info.plist"), "utf8")).toBe("2.0.2");
    expect(f.run("install").status).toBe(0);
    expect(readFileSync(join(f.app, "Contents", "Info.plist"), "utf8")).toBe(version);
    expect(readFileSync(join(f.home, ".recall", "recall.db"), "utf8")).toBe("local memories");
    expect(readFileSync(f.result, "utf8")).toBe(`success\t${version}\n`);
    expect(existsSync(stage)).toBe(false);
    expect(readFileSync(f.calls, "utf8")).toContain('identifier "com.edihasaj.recall" and certificate leaf[subject.OU] = "T8J48M4QVY"');
    expect(readFileSync(f.calls, "utf8")).toContain(`open ${f.app}`);
  });

  it.each(["BAD_CHECKSUM", "BAD_SIGNATURE", "BAD_NOTARIZATION"])("rejects %s before touching the installed app", (failure) => {
    const f = fixture({ [failure]: "1" });
    expect(f.run("prepare").status).not.toBe(0);
    expect(existsSync(f.state)).toBe(false);
    expect(readFileSync(join(f.app, "Contents", "Info.plist"), "utf8")).toBe("2.0.2");
    expect(existsSync(f.calls) ? readFileSync(f.calls, "utf8") : "").not.toContain("daemon stop");
  });

  it("rejects an archive with the wrong version", () => {
    const f = fixture();
    writeFileSync(join(f.incoming, "Contents", "Info.plist"), "1.4.21");
    expect(f.run("prepare").status).not.toBe(0);
    expect(existsSync(f.state)).toBe(false);
  });

  it("verifies the staged app again before stopping the old daemon", () => {
    const f = fixture();
    expect(f.run("prepare").status).toBe(0);
    const stage = readFileSync(f.state, "utf8").trim();
    writeFileSync(join(stage, "unpacked", "Recall.app", "Contents", "Info.plist"), "1.0.0");
    expect(f.run("install").status).not.toBe(0);
    expect(readFileSync(f.calls, "utf8")).not.toContain("daemon stop");
    expect(readFileSync(f.result, "utf8")).toBe(`failed\t${version}\n`);
  });

  it.each([{ FAIL_RESTART: "1" }, { FAIL_SWAP: "1" }, { HEALTH_VERSION: "2.0.2" }])("restores the old app after %j", (failure) => {
    const f = fixture(failure);
    expect(f.run("prepare").status).toBe(0);
    expect(f.run("install").status).not.toBe(0);
    expect(readFileSync(join(f.app, "Contents", "Info.plist"), "utf8")).toBe("2.0.2");
    expect(readFileSync(join(f.home, ".recall", "recall.db"), "utf8")).toBe("local memories");
    expect(readFileSync(f.result, "utf8")).toBe(`failed\t${version}\n`);
    expect(readFileSync(f.calls, "utf8")).toContain("2.0.2 daemon restart");
    expect(readFileSync(f.calls, "utf8")).toContain(`open ${f.app}`);
  });
});
