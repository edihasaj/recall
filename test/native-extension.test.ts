import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  require: vi.fn(),
  upstreamPath: vi.fn(() => "/upstream/vec0"),
  upstreamLoad: vi.fn(),
  candidatePath: vi.fn(() => "C:/candidate/vec0.dll"),
  probeLoad: vi.fn(),
  probeQuery: vi.fn(),
  probeClose: vi.fn(),
}));

vi.mock("node:module", () => ({ createRequire: () => mocks.require }));
vi.mock("sqlite-vec", () => ({ getLoadablePath: mocks.upstreamPath, load: mocks.upstreamLoad }));
vi.mock("better-sqlite3", () => ({
  default: class {
    loadExtension = mocks.probeLoad;
    prepare = () => ({ get: mocks.probeQuery });
    close = mocks.probeClose;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.upstreamPath.mockReturnValue("/upstream/vec0");
  mocks.candidatePath.mockReturnValue("C:/candidate/vec0.dll");
  mocks.require.mockReturnValue({ getLoadablePath: mocks.candidatePath });
});
afterEach(() => vi.unstubAllGlobals());

function platform(os: string, arch: string) {
  vi.stubGlobal("process", { ...process, platform: os, arch });
}

describe("native vector extension selection", () => {
  it.each([['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']])(
    "preserves the upstream loader on %s %s", async (os, arch) => {
      platform(os, arch);
      const extension = await import("../src/vector/native-extension.js");
      const db = { loadExtension: vi.fn() };
      expect(extension.getLoadablePath()).toBe("/upstream/vec0");
      extension.load(db);
      expect(mocks.upstreamLoad).toHaveBeenCalledWith(db);
      expect(mocks.require).not.toHaveBeenCalled();
      expect(mocks.probeLoad).not.toHaveBeenCalled();
    },
  );

  it("loads and probes the ARM64 DLL once, then uses it for each database", async () => {
    platform("win32", "arm64");
    const extension = await import("../src/vector/native-extension.js");
    const db = { loadExtension: vi.fn() };
    expect(extension.getLoadablePath()).toBe("C:/candidate/vec0.dll");
    extension.load(db);
    extension.load(db);
    expect(mocks.require).toHaveBeenCalledExactlyOnceWith("@photostructure/sqlite-vec");
    expect(mocks.probeLoad).toHaveBeenCalledExactlyOnceWith("C:/candidate/vec0.dll");
    expect(mocks.probeQuery).toHaveBeenCalledOnce();
    expect(mocks.probeClose).toHaveBeenCalledOnce();
    expect(db.loadExtension).toHaveBeenCalledTimes(2);
    expect(mocks.upstreamLoad).not.toHaveBeenCalled();
  });

  it.each(["missing package", "missing DLL", "invalid DLL"])("reports %s without repeatedly loading it", async (failure) => {
    platform("win32", "arm64");
    const failing = failure === "missing package" ? mocks.require
      : failure === "missing DLL" ? mocks.candidatePath : mocks.probeLoad;
    failing.mockImplementation(() => { throw new Error(failure); });
    const extension = await import("../src/vector/native-extension.js");
    expect(() => extension.getLoadablePath()).toThrow(failure);
    expect(() => extension.getLoadablePath()).toThrow(failure);
    expect(failing).toHaveBeenCalledOnce();
    if (failure === "invalid DLL") expect(mocks.probeClose).toHaveBeenCalledOnce();
    expect(mocks.upstreamLoad).not.toHaveBeenCalled();
  });
});
