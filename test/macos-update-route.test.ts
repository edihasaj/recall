import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")("offers in-app updates to writable direct installs without Homebrew", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-update-route-"));
  const harness = join(root, "main.swift");
  const binary = join(root, "route-test");
  writeFileSync(harness, `
    import Foundation
    let app = "/Applications/Recall.app"
    precondition(UpdateController.canInstallInApp(at: app, homebrew: false, writable: { _ in true }))
    precondition(UpdateController.canInstallInApp(at: app, homebrew: true, writable: { _ in false }))
    precondition(!UpdateController.canInstallInApp(at: app, homebrew: false, writable: { $0 != app }))
    precondition(!UpdateController.canInstallInApp(at: app, homebrew: false, writable: { $0 == app }))
    precondition(!UpdateController.canInstallInApp(at: "/Downloads/Recall.app", homebrew: false, writable: { _ in true }))
    print("update routes passed")
  `);
  execFileSync("swiftc", ["-swift-version", "6",
    resolve("macos/RecallApp/Recall/UpdateController.swift"), harness, "-o", binary], { timeout: 90_000 });
  expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("update routes passed");
}, 100_000);
