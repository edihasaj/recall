import { describe, expect, it } from "vitest";
import { systemdInstallCommands } from "../src/daemon/systemd.js";

describe("systemd daemon install", () => {
  it("restarts an existing service so package upgrades take effect", () => {
    expect(systemdInstallCommands("recall-daemon")).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "recall-daemon.service"],
      ["--user", "restart", "recall-daemon.service"],
    ]);
  });
});
