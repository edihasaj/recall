import { expect, it } from "vitest";
import { ensureLaunchdStarted } from "../src/daemon/launchd-start.js";

it("reloads a job removed between bootstrap and kickstart", () => {
  let loaded = false, kicks = 0, bootstraps = 0;
  ensureLaunchdStarted("gui/501", "com.recall.daemon", "/fixture.plist", (args) => {
    if (args[0] === "print" && !loaded) throw new Error("not found");
    if (args[0] === "bootstrap") { loaded = true; bootstraps++; }
    if (args[0] === "kickstart" && ++kicks === 1) { loaded = false; throw new Error("service disappeared"); }
  }, () => {});
  expect(bootstraps).toBe(2);
  expect(kicks).toBe(2);
});

it("accepts a competing bootstrap that loaded the same job", () => {
  let loaded = false, kicked = false;
  ensureLaunchdStarted("gui/501", "com.recall.daemon", "/fixture.plist", (args) => {
    if (args[0] === "print" && !loaded) throw new Error("not found");
    if (args[0] === "bootstrap") { loaded = true; throw new Error("already loaded"); }
    if (args[0] === "kickstart") kicked = true;
  }, () => {});
  expect(kicked).toBe(true);
});

it("reports the actual bootstrap failure after bounded retries", () => {
  const failure = new Error("Bootstrap failed: permission denied");
  let tries = 0;
  expect(() => ensureLaunchdStarted("gui/501", "com.recall.daemon", "/fixture.plist", (args) => {
    if (args[0] === "bootstrap") { tries++; throw failure; }
    throw new Error("not found");
  }, () => {})).toThrow(failure);
  expect(tries).toBe(3);
});

it("does not retry unrelated kickstart failures on a loaded job", () => {
  let kicks = 0;
  expect(() => ensureLaunchdStarted("gui/501", "com.recall.daemon", "/fixture.plist", (args) => {
    if (args[0] === "kickstart") { kicks++; throw new Error("permission denied"); }
  }, () => {})).toThrow("permission denied");
  expect(kicks).toBe(1);
});

it("starts a loaded job without killing the running instance", () => {
  const calls: string[][] = [];
  ensureLaunchdStarted("gui/501", "com.recall.daemon", "/fixture.plist", (args) => {
    calls.push(args);
  }, () => {});
  expect(calls).toEqual([
    ["print", "gui/501/com.recall.daemon"],
    ["kickstart", "gui/501/com.recall.daemon"],
  ]);
});
