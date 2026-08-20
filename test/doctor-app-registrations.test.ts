import { describe, expect, it } from "vitest";
import {
  INSTALLED_APP_PATH,
  inspectAppRegistrations,
  parseRegisteredAppPaths,
  unregisterStrayApps,
} from "../src/doctor/app-registrations.js";

// Trimmed from a real `lsregister -dump` on a machine that had drifted to 31
// registered bundles: local Xcode builds, upgrade leftovers in the Trash, an
// old unpacked release in /tmp, and a build on an external volume.
const DUMP = `
	bundle	id:            12345
	path:                       /Applications/Recall.app (0x13510)
	executable:                 Contents/MacOS/Recall
	--------------------------------------------------------
	path:                       /Users/edi/.Trash/Recall.app.old.1349 (0x18164)
	path:                       /Users/edi/Projects/recall/build/DerivedData/Build/Products/Release/Recall.app (0x130cc)
	path:                       /private/tmp/recall-0.7.3/unpacked/Recall.app (0xa144)
	path:                       /Volumes/edi/Library/Developer/Xcode/DerivedData/RecallApp-abc/Build/Products/Debug/Recall.app (0xa270)
	path:                       /Applications/Some Other App.app (0x1111)
`;

describe("stray Recall.app registrations", () => {
  it("extracts only Recall bundles from an lsregister dump", () => {
    const paths = parseRegisteredAppPaths(DUMP);
    expect(paths).toContain(INSTALLED_APP_PATH);
    expect(paths).toContain("/Users/edi/.Trash/Recall.app.old.1349");
    expect(paths).toContain(
      "/Users/edi/Projects/recall/build/DerivedData/Build/Products/Release/Recall.app",
    );
    // Unrelated applications are never touched.
    expect(paths).not.toContain("/Applications/Some Other App.app");
  });

  it("separates the installed bundle from the strays", () => {
    const report = inspectAppRegistrations({ dump: DUMP, platform: "darwin" });
    expect(report.supported).toBe(true);
    expect(report.installed_registered).toBe(true);
    expect(report.stray_paths).toHaveLength(4);
    expect(report.stray_paths).not.toContain(INSTALLED_APP_PATH);
  });

  it("reports a healthy machine as having no strays", () => {
    const clean = "	path:                       /Applications/Recall.app (0x13510)";
    const report = inspectAppRegistrations({ dump: clean, platform: "darwin" });
    expect(report.installed_registered).toBe(true);
    expect(report.stray_paths).toEqual([]);
  });

  it("is inapplicable off macOS and when lsregister is unavailable", () => {
    expect(inspectAppRegistrations({ dump: DUMP, platform: "linux" }).supported).toBe(false);
    expect(inspectAppRegistrations({ dump: null, platform: "darwin" }).supported).toBe(false);
  });

  it("unregisters strays but never the installed bundle", () => {
    const attempted: string[] = [];
    const result = unregisterStrayApps(
      [
        "/Users/edi/.Trash/Recall.app.old.1349",
        INSTALLED_APP_PATH,
        "/private/tmp/recall-0.7.3/unpacked/Recall.app",
      ],
      { platform: "darwin", run: (path) => { attempted.push(path); return true; } },
    );

    expect(attempted).not.toContain(INSTALLED_APP_PATH);
    expect(result.unregistered).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });

  it("reports paths it could not unregister instead of claiming success", () => {
    const result = unregisterStrayApps(["/Volumes/gone/Recall.app"], {
      platform: "darwin",
      run: () => false,
    });
    expect(result.unregistered).toEqual([]);
    expect(result.failed).toEqual(["/Volumes/gone/Recall.app"]);
  });

  it("does nothing off macOS", () => {
    const result = unregisterStrayApps(["/anywhere/Recall.app"], { platform: "linux" });
    expect(result.unregistered).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
