import { describe, expect, it } from "vitest";
import {
  isAllowedBrowserOrigin,
  isLoopbackAddress,
} from "../src/daemon/http-security.js";

describe("daemon HTTP security", () => {
  it("accepts only loopback peer addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("accepts HTTP browser origins only on loopback", () => {
    expect(isAllowedBrowserOrigin("http://127.0.0.1:7891")).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://[::1]:7891")).toBe(true);
    expect(isAllowedBrowserOrigin("https://example.com")).toBe(false);
    expect(isAllowedBrowserOrigin("null")).toBe(false);
    expect(isAllowedBrowserOrigin("not a URL")).toBe(false);
  });
});
