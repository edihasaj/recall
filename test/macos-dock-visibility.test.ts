import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")("shows the Dock temporarily with both persistent icons off", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-dock-"));
  const harness = join(root, "main.swift");
  const binary = join(root, "dock-test");
  writeFileSync(harness, `
    import AppKit
    let app = NSApplication.shared
    let preferences = AppPreferences()
    preferences.setShowMenuBarIcon(false)
    preferences.setShowDockIcon(false)
    precondition(app.activationPolicy() == .accessory)
    preferences.setDashboardVisible(true)
    precondition(app.activationPolicy() == .regular)
    precondition(!preferences.showDockIcon && !preferences.showMenuBarIcon)
    preferences.setShowDockIcon(false)
    precondition(app.activationPolicy() == .regular)
    preferences.setDashboardVisible(false)
    precondition(app.activationPolicy() == .accessory)
    preferences.setShowDockIcon(true)
    preferences.setDashboardVisible(true)
    preferences.setDashboardVisible(false)
    precondition(app.activationPolicy() == .regular)
    preferences.setShowDockIcon(false)
    UserDefaults.standard.removeObject(forKey: "showDockIcon")
    UserDefaults.standard.removeObject(forKey: "showMenuBarIcon")
    print("dock visibility passed")
  `);
  execFileSync("swiftc", ["-swift-version", "6",
    resolve("macos/RecallApp/Recall/AppPreferences.swift"), harness, "-o", binary], { timeout: 90_000 });
  expect(execFileSync(binary, { encoding: "utf8", timeout: 30_000 }).trim()).toBe("dock visibility passed");
}, 130_000);
