import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { CloudError } from "./errors.js";

/** Same token rules as the sync engine, so a file we write is always readable by it. */
export function normalizeSecret(value: unknown, label: string): string {
  const secret = String(value ?? "");
  if (!secret || secret.length > 4096 || secret !== secret.trim() || /[\r\n\0]/.test(secret)) {
    throw new CloudError(`Invalid ${label}`, "invalid");
  }
  return secret;
}

export function ensurePrivateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CloudError("Credential directory is not a real directory", "invalid");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CloudError("Credential directory is not owned by the current user", "invalid");
  }
  chmodSync(directory, 0o700);
}

export function writePrivateFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function validatePrivateFile(filePath: string): void {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new CloudError("Credential file is missing", "token-missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CloudError("Credential path must be a regular file", "invalid");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CloudError("Credential file must be owned by the current user", "invalid");
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw new CloudError("Credential file must have mode 0600", "invalid");
  }
}

export function readPrivateSecret(filePath: string, label: string): string {
  validatePrivateFile(filePath);
  return normalizeSecret(readFileSync(filePath, "utf8"), label);
}

export function removeFile(filePath: string): void {
  rmSync(filePath, { force: true });
}

/** Passphrases may contain spaces; only emptiness, size and NUL are rejected. */
export function normalizePassphrase(value: unknown): string {
  const passphrase = String(value ?? "");
  if (!passphrase || passphrase.length > 4096 || passphrase.includes("\0")) {
    throw new CloudError("Invalid E2EE passphrase", "invalid");
  }
  return passphrase;
}

export function readPrivatePassphrase(filePath: string): string {
  validatePrivateFile(filePath);
  return normalizePassphrase(readFileSync(filePath, "utf8"));
}
