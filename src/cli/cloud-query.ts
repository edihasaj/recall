import type { Command } from "commander";
import { cloudQueryStatus, setCloudQueryEnabled } from "../cloud/query-settings.js";

export function registerCloudQueryCommands(program: Command): void {
  program.command("cloud-query [mode]")
    .description("Online memory lookup defaults on for connected Cloud; off keeps retrieval local")
    .action((mode = "status") => {
      if (!["on", "off", "status"].includes(mode)) {
        throw new Error("Use cloud-query on, off, or status");
      }
      if (mode !== "status") setCloudQueryEnabled(mode === "on");
      console.log(JSON.stringify(cloudQueryStatus()));
    });
}
