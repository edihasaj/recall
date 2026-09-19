import { createRequire } from "node:module";
import Database from "better-sqlite3";
import * as upstream from "sqlite-vec";

const require = createRequire(import.meta.url);
let windowsChecked = false;
let windowsPath: string;
let windowsError: Error | undefined;

function needsWindowsArmExtension(): boolean {
  return process.platform === "win32" && process.arch === "arm64";
}

/** Keep the existing loader everywhere except native Windows ARM64. */
export function getLoadablePath(): string {
  if (!needsWindowsArmExtension()) return upstream.getLoadablePath();
  if (!windowsChecked) {
    try {
      // Optional and lazy: its absence must not prevent the daemon starting,
      // or affect an installation that uses the upstream extension.
      const extension = require("@photostructure/sqlite-vec") as {
        getLoadablePath(): string;
      };
      windowsPath = extension.getLoadablePath();
      const probe = new Database(":memory:");
      try {
        probe.loadExtension(windowsPath);
        probe.prepare("select vec_version()").get();
      } finally {
        probe.close();
      }
    } catch (error) {
      windowsError = error instanceof Error ? error : new Error(String(error));
    }
    // Failed native loads are sticky until restart, avoiding a retry on every
    // health request and embedding job while lexical retrieval stays usable.
    windowsChecked = true;
  }
  if (windowsError) throw windowsError;
  return windowsPath;
}

export function load(db: Pick<Database.Database, "loadExtension">): void {
  if (!needsWindowsArmExtension()) {
    upstream.load(db);
    return;
  }
  db.loadExtension(getLoadablePath());
}
