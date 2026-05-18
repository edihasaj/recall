import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { start, stop, isRunning } from "../src/webui/server.js";
import { emit } from "../src/daemon/events.js";

async function pickPort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function decodeUnmaskedTextFrame(buf: Buffer): { text: string; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let lenByte = buf[1] & 0x7f;
  let offset = 2;
  let len = lenByte;
  if (lenByte === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (lenByte === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf.length < offset + len) return null;
  const payload = buf.subarray(offset, offset + len);
  const rest = buf.subarray(offset + len);
  if (opcode === 0x1) {
    return { text: payload.toString("utf8"), rest };
  }
  // Skip non-text frames; pull the next one out of the rest.
  return decodeUnmaskedTextFrame(rest) ?? { text: "", rest };
}

describe("webui websocket", () => {
  afterEach(async () => {
    if (isRunning()) await stop();
  });

  it("upgrades, sends hello, and forwards bus events", async () => {
    const port = await pickPort();
    await start({ port });

    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    const messages: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let buf = Buffer.alloc(0);
      let upgraded = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timeout — messages: ${JSON.stringify(messages)}`));
      }, 2000);

      socket.on("connect", () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            "Host: 127.0.0.1",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "\r\n",
          ].join("\r\n"),
        );
      });

      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const headerEnd = buf.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headers = buf.subarray(0, headerEnd).toString("utf8");
          expect(headers).toContain("101 Switching Protocols");
          expect(headers).toContain(`Sec-WebSocket-Accept: ${expectedAccept}`);
          upgraded = true;
          buf = buf.subarray(headerEnd + 4);
        }
        while (buf.length >= 2) {
          const decoded = decodeUnmaskedTextFrame(buf);
          if (!decoded) break;
          if (decoded.text) messages.push(decoded.text);
          buf = decoded.rest;
          if (messages.length >= 2) {
            clearTimeout(timeout);
            socket.end();
            resolve();
            return;
          }
        }
      });

      socket.on("error", reject);
    });

    // Give the upgrade handler a beat to subscribe to the bus.
    await new Promise((r) => setTimeout(r, 50));
    emit("memory.created", { memory_id: "m-test", repo: "demo", source: "test" });

    await done;

    expect(messages[0]).toContain('"hello"');
    expect(messages[1]).toContain('"memory.created"');
    expect(messages[1]).toContain('"m-test"');
  });
});
