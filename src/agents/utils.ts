import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export function resolveUserHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function hasCommand(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
