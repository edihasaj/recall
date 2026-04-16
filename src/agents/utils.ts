import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export function resolveUserHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function hasCommand(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
