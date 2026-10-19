/**
 * Persistent operator identity for the local UMP server.
 *
 * UMP scope ownership is meaningful only when a server keeps the same
 * did:key across restarts. The seed never leaves this module and is stored
 * beside Recall's SQLite database with owner-only permissions.
 */

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair, type KeyPair } from "@universalmemoryprotocol/core";
import { getDbPath } from "../db/client.js";

const SEED_FILE = "ump-operator-ed25519.seed";
const ED25519_SEED_LENGTH = 32;

export function loadPersistedUmpOperatorKey(dbPath = getDbPath()): KeyPair {
  const path = join(dirname(dbPath), SEED_FILE);
  let seed: Uint8Array;
  try {
    seed = new Uint8Array(readFileSync(path));
  } catch (error) {
    if (!isMissingFile(error)) throw new Error("Unable to read Recall UMP operator identity");
    seed = createSeed(path);
  }

  if (seed.byteLength !== ED25519_SEED_LENGTH) {
    // A malformed identity must never silently create a new DID: doing that
    // would make old private records inaccessible under a different owner.
    throw new Error("Invalid persisted Recall UMP operator identity");
  }
  return generateKeyPair(seed);
}

function createSeed(path: string): Uint8Array {
  const seed = randomBytes(ED25519_SEED_LENGTH);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    // Publish only a complete, fsync'd seed. Linking a private temporary file
    // into place is exclusive: another process either wins with its own full
    // seed or reads this full one; no reader can observe a zero-byte target.
    fd = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, seed);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporaryPath, path);
    return seed;
  } catch (error) {
    if (isAlreadyExists(error)) {
      const existing = new Uint8Array(readFileSync(path));
      if (existing.byteLength !== ED25519_SEED_LENGTH) {
        throw new Error("Invalid persisted Recall UMP operator identity");
      }
      return existing;
    }
    throw new Error("Unable to create Recall UMP operator identity");
  } finally {
    if (fd !== undefined) closeSync(fd);
    // The temporary file is uniquely owned by this invocation and contains no
    // durable state after link() succeeds or another process wins the race.
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Cleanup failure never changes the established operator identity.
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "EEXIST";
}
