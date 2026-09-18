import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCodexHomes } from "../agents/codex.js";

export interface CodexTrustReport {
  home: string;
  status: "trusted" | "review-required" | "unavailable";
  hooks: Array<{ event: string; trust: string; enabled: boolean }>;
  error?: string;
}

export async function inspectCodexTrust(): Promise<CodexTrustReport[]> {
  return Promise.all(resolveCodexHomes().map(probeCodexHome));
}

function probeCodexHome(home: string): Promise<CodexTrustReport> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    let settled = false;
    const finish = (report: CodexTrustReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.close();
      child.kill();
      resolve(report);
    };
    const unavailable = (error: string) => finish({ home, status: "unavailable", hooks: [], error });
    const timer = setTimeout(() => unavailable("Codex hook inspection timed out"), 5000);
    const reader = createInterface({ input: child.stdout });
    child.on("error", (error) => unavailable(error.message));
    child.on("exit", () => { if (!settled) unavailable("Codex exited before reporting hook trust"); });
    child.stdin.on("error", () => unavailable("Codex closed the inspection connection"));
    reader.on("line", (line) => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.error) { unavailable("This Codex runtime cannot inspect hooks through app-server"); return; }
      if (response.id === 1) {
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        child.stdin.write(JSON.stringify({ id: 2, method: "hooks/list", params: { cwds: [process.cwd()] } }) + "\n");
      } else if (response.id === 2) {
        const hooks: CodexTrustReport["hooks"] = [];
        for (const entry of response.result?.data ?? []) {
          for (const hook of entry.hooks ?? []) {
            if (typeof hook.command !== "string" || !hook.command.includes("recall:managed:codex:")) continue;
            hooks.push({ event: hook.eventName, trust: hook.trustStatus, enabled: hook.enabled });
          }
        }
        finish({ home, status: hooks.length > 0 && hooks.every((h) => h.enabled && ["trusted", "managed"].includes(h.trust)) ? "trusted" : "review-required", hooks });
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "recall-doctor", version: "1" }, capabilities: { experimentalApi: true },
    } }) + "\n");
  });
}
