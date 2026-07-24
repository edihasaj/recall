import { describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteUtf8File,
  readUtf8FileIfExists,
} from "../src/security/atomic-file.js";

describe("atomic file helpers", () => {
  it("writes owner-only files and atomically replaces existing content", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-atomic-"));
    const target = join(dir, "config.json");
    writeFileSync(target, "old", { mode: 0o644 });

    atomicWriteUtf8File(target, "new");

    expect(readFileSync(target, "utf-8")).toBe("new");
    if (process.platform !== "win32") {
      expect(lstatSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null only for a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-atomic-"));
    expect(readUtf8FileIfExists(join(dir, "missing"))).toBeNull();
  });

  it.runIf(process.platform !== "win32")("refuses to follow symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-atomic-"));
    const real = join(dir, "real");
    const link = join(dir, "link");
    writeFileSync(real, "secret");
    symlinkSync(real, link);

    expect(() => readUtf8FileIfExists(link)).toThrow();
    atomicWriteUtf8File(link, "safe");
    expect(readFileSync(real, "utf-8")).toBe("secret");
    expect(readFileSync(link, "utf-8")).toBe("safe");
  });
});
