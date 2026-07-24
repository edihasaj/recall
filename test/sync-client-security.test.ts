import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeam, joinTeam } from "../src/sync/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sync client security", () => {
  it("rejects unsafe destinations before calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      createTeam(
        { remote_url: "http://127.0.0.1:8080", api_key: "secret" },
        "test",
      ),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects redirects and encodes team IDs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await joinTeam(
      { remote_url: "https://sync.example.com/v1/", api_key: "secret" },
      "../other/team",
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://sync.example.com/v1/api/team/..%2Fother%2Fteam/join",
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
