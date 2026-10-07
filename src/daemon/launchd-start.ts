import { execFileSync } from "node:child_process";

type Run = (args: string[]) => void;

/** A second controller may unload the job between bootstrap and kickstart. */
export function ensureLaunchdStarted(
  domain: string,
  label: string,
  plist: string,
  run: Run = (args) => { execFileSync("launchctl", args, { stdio: "pipe" }); },
  pause: () => void = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); },
): void {
  const target = `${domain}/${label}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let loaded = false;
    try { run(["print", target]); loaded = true; } catch { /* Not loaded yet. */ }
    if (!loaded) {
      try { run(["bootstrap", domain, plist]); } catch (error) {
        lastError = error;
        // A concurrent bootstrap can report failure even though the job exists.
        try { run(["print", target]); loaded = true; } catch { /* Retry below. */ }
        if (!loaded) { if (attempt < 2) pause(); continue; }
      }
    }
    try { run(["kickstart", "-k", target]); return; } catch (error) {
      lastError = error;
      // Retry only when the job disappeared. Other kickstart errors are real.
      try { run(["print", target]); } catch { if (attempt < 2) pause(); continue; }
      throw error;
    }
  }
  throw lastError;
}
