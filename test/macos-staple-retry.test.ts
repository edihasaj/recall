import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/staple-macos-release.sh");

function run(mode: "already-valid" | "transient" | "permanent") {
  const root = mkdtempSync(join(tmpdir(), "recall-staple-retry-"));
  const app = join(root, "Recall Test.app");
  const bin = join(root, "bin");
  const calls = join(root, "xcrun.calls");
  const sleeps = join(root, "sleep.calls");
  const attempts = join(root, "staple.attempts");
  const ticket = join(root, "ticket");
  mkdirSync(app);
  mkdirSync(bin);

  const xcrun = join(bin, "xcrun");
  writeFileSync(xcrun, `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_XCRUN_CALLS"
if [ "$1" != stapler ]; then exit 2; fi
if [ "$2" = validate ]; then
  [ "$MOCK_MODE" = already-valid ] && exit 0
  [ -f "$MOCK_TICKET" ] && exit 0
  exit 1
fi
if [ "$2" = staple ]; then
  count=0
  [ -f "$MOCK_ATTEMPTS" ] && count=$(cat "$MOCK_ATTEMPTS")
  count=$((count + 1))
  printf '%s' "$count" > "$MOCK_ATTEMPTS"
  if [ "$MOCK_MODE" = permanent ] || [ "$count" -lt 2 ]; then exit 1; fi
  : > "$MOCK_TICKET"
  exit 0
fi
exit 2
`);
  chmodSync(xcrun, 0o755);

  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOCK_SLEEP_CALLS\"\n");
  chmodSync(sleep, 0o755);

  const result = spawnSync("bash", [script, app], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_MODE: mode,
      MOCK_XCRUN_CALLS: calls,
      MOCK_SLEEP_CALLS: sleeps,
      MOCK_ATTEMPTS: attempts,
      MOCK_TICKET: ticket,
    },
  });
  const lines = (path: string) => {
    try {
      return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { result, xcrun: lines(calls), sleeps: lines(sleeps) };
}

describe("macOS release stapling", () => {
  it("does not staple an app with an existing valid ticket", () => {
    const result = run("already-valid");
    expect(result.result.status, result.result.stderr).toBe(0);
    expect(result.xcrun).toHaveLength(1);
    expect(result.xcrun[0]).toMatch(/^stapler validate /);
    expect(result.sleeps).toEqual([]);
  });

  it("retries a transient staple failure and validates the ticket", () => {
    const result = run("transient");
    expect(result.result.status, result.result.stderr).toBe(0);
    expect(result.xcrun.filter((call) => call.startsWith("stapler staple "))).toHaveLength(2);
    expect(result.xcrun.filter((call) => call.startsWith("stapler validate "))).toHaveLength(2);
    expect(result.sleeps).toEqual(["15"]);
  });

  it("fails after five staple attempts when no valid ticket appears", () => {
    const result = run("permanent");
    expect(result.result.status).not.toBe(0);
    expect(result.xcrun.filter((call) => call.startsWith("stapler staple "))).toHaveLength(5);
    expect(result.xcrun.filter((call) => call.startsWith("stapler validate "))).toHaveLength(2);
    expect(result.sleeps).toEqual(["15", "15", "15", "15"]);
  });
});
