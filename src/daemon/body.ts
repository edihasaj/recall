import type { IncomingMessage } from "node:http";

export const MAX_DAEMON_BODY_BYTES = 1024 * 1024;

export class JsonBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "JsonBodyError";
  }
}

export async function parseJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_DAEMON_BODY_BYTES,
): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(bytes);
  }

  if (tooLarge) {
    throw new JsonBodyError("request body too large", 413);
  }
  if (total === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new JsonBodyError("invalid JSON body", 400);
  }
}
