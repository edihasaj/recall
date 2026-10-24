import * as http from "node:http";
import * as https from "node:https";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function abortError(signal: AbortSignal) {
  const name = signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError";
  return new DOMException(name === "TimeoutError" ? "Request timed out" : "Request aborted", name);
}

function normalizeHeaders(input: RequestInit["headers"] | undefined): Record<string, string> {
  if (!input) return {};
  const entries = input instanceof Headers ? [...input.entries()]
    : Array.isArray(input) ? input : Object.entries(input);
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new TypeError("Invalid request headers");
    }
    headers[entry[0]] = entry[1];
  }
  return headers;
}

function toResponseHeaders(input: http.IncomingHttpHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    for (const part of Array.isArray(value) ? value : [value]) headers.append(name, part);
  }
  return headers;
}

function boundedBody(response: http.IncomingMessage, signal: AbortSignal | null): ReadableStream<Uint8Array> {
  let bytes = 0;
  let ended = false;
  let removeAbort = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => {
        if (ended) return;
        ended = true;
        removeAbort();
      };
      const fail = (error: Error | DOMException) => {
        if (ended) return;
        finish();
        response.destroy(error);
        controller.error(error);
      };
      const onData = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) return fail(new Error("Response body exceeds limit"));
        controller.enqueue(new Uint8Array(chunk));
      };
      const onEnd = () => {
        if (ended) return;
        finish();
        controller.close();
      };
      const onError = () => fail(new Error("Response body read failed"));
      response.on("data", onData);
      response.once("end", onEnd);
      response.once("error", onError);
      if (signal) {
        const onAbort = () => fail(abortError(signal));
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      }
    },
    cancel() {
      if (!ended) {
        ended = true;
        removeAbort();
        response.destroy();
      }
    },
  });
}

/**
 * Native HTTP transport for long local inference calls.
 *
 * It deliberately has no header timer; the supplied AbortSignal is the entire
 * request-and-body deadline. Node's native fetch otherwise applies a shorter
 * implicit header timeout on this benchmark path.
 */
export function longRequestFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new TypeError("Invalid request URL"));
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new TypeError("Unsupported request protocol"));
  }
  if (target.username || target.password) {
    return Promise.reject(new TypeError("Credential-bearing request URLs are not allowed"));
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    return Promise.reject(new TypeError("Request body must be a string"));
  }
  if (init.method !== undefined && typeof init.method !== "string") {
    return Promise.reject(new TypeError("Invalid request method"));
  }
  let headers: Record<string, string>;
  try {
    headers = normalizeHeaders(init.headers);
  } catch {
    return Promise.reject(new TypeError("Invalid request headers"));
  }
  const signal = init.signal ?? null;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<Response>((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    let settled = false;
    let request: http.ClientRequest;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error | DOMException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      request.destroy(abortError(signal!));
      fail(abortError(signal!));
    };
    try {
      request = client.request(target, { method: init.method ?? "GET", headers }, (response) => {
        try {
          const contentLength = Number(response.headers["content-length"]);
          if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
            response.once("error", () => undefined);
            response.destroy(new Error("Response body exceeds limit"));
            fail(new Error("Response body exceeds limit"));
            return;
          }
          const status = response.statusCode ?? 500;
          const body = status === 204 || status === 205 || status === 304 ? null : boundedBody(response, signal);
          if (body === null) response.resume();
          if (settled) {
            response.destroy();
            return;
          }
          const result = new Response(body, {
            status,
            statusText: response.statusMessage ?? "",
            headers: toResponseHeaders(response.headers),
          });
          settled = true;
          cleanup();
          resolve(result);
        } catch {
          response.once("error", () => undefined);
          response.destroy();
          fail(new Error("Response construction failed"));
        }
      });
    } catch {
      return fail(new Error("Network request failed"));
    }
    request.once("error", () => fail(new Error("Network request failed")));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try {
      if (typeof init.body === "string") request.write(init.body);
      request.end();
    } catch {
      request.destroy();
      fail(new Error("Network request failed"));
    }
  });
}
