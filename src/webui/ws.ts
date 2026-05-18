/**
 * Minimal WebSocket broadcaster. Implements the subset of RFC 6455 needed
 * to push small JSON frames to localhost clients: server-side handshake,
 * text-frame send with 7-bit / 16-bit length, ping/pong, graceful close.
 *
 * No client-to-server payloads are interpreted — the WebUI is read-only
 * over this channel. Mutations go through the daemon REST API.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { onAny, type EventEnvelope } from "../daemon/events.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface Client {
  socket: Socket;
  alive: boolean;
}

const clients = new Set<Client>();
let pingTimer: NodeJS.Timeout | null = null;
let busUnsubscribe: (() => void) | null = null;

export function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr === "localhost"
  );
}

export function handleUpgrade(req: IncomingMessage, socket: Socket): void {
  if (!isLocalRequest(req)) {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );

  const client: Client = { socket, alive: true };
  clients.add(client);
  socket.on("close", () => {
    clients.delete(client);
  });
  socket.on("error", () => {
    clients.delete(client);
    socket.destroy();
  });
  // Minimal frame parser: only watches for close / pong opcodes so the
  // socket can shut down cleanly. Data frames from the client are dropped.
  socket.on("data", (chunk: Buffer) => {
    if (chunk.length < 2) return;
    const opcode = chunk[0] & 0x0f;
    if (opcode === 0x8) {
      // close
      writeFrame(socket, 0x8, Buffer.alloc(0));
      socket.end();
      clients.delete(client);
    } else if (opcode === 0xa) {
      // pong
      client.alive = true;
    }
  });
  // Greeting so the client knows the channel is up.
  writeText(
    socket,
    JSON.stringify({ name: "hello", payload: { version: 1 }, ts: new Date().toISOString() }),
  );
  ensurePingLoop();
  ensureBusBridge();
}

function ensureBusBridge(): void {
  if (busUnsubscribe) return;
  busUnsubscribe = onAny((envelope: EventEnvelope) => {
    if (clients.size === 0) return;
    const json = JSON.stringify(envelope);
    for (const c of clients) {
      writeText(c.socket, json);
    }
  });
}

function ensurePingLoop(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    if (clients.size === 0) return;
    for (const c of clients) {
      if (!c.alive) {
        c.socket.destroy();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      try {
        writeFrame(c.socket, 0x9, Buffer.alloc(0)); // ping
      } catch {
        clients.delete(c);
      }
    }
  }, 30_000);
  pingTimer.unref?.();
}

function writeText(socket: Socket, text: string): void {
  try {
    writeFrame(socket, 0x1, Buffer.from(text, "utf8"));
  } catch {
    // Socket already dead — handler in 'error'/'close' will clean up.
  }
}

function writeFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

export function clientCount(): number {
  return clients.size;
}

export function shutdown(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  busUnsubscribe?.();
  busUnsubscribe = null;
  for (const c of clients) {
    try {
      writeFrame(c.socket, 0x8, Buffer.alloc(0));
      c.socket.end();
    } catch {
      // ignore
    }
  }
  clients.clear();
}
