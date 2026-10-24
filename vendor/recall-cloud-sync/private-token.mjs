import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export function normalizeToken(value) {
  const token = String(value ?? "");
  if (!token || token.length > 4096 || token !== token.trim() || /[\r\n\0]/.test(token)) {
    throw new Error("Invalid Recall Cloud token");
  }
  return token;
}

export function readPrivateTokenFile(filePath) {
  const resolvedPath = resolve(expandHome(filePath));
  validatePrivateFile(resolvedPath);
  return normalizeToken(readFileSync(resolvedPath, "utf8"));
}

export function writePrivateTokenFile(filePath, token) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Credential directory is not a real directory: ${directory}`);
  }
  validateOwner(directory, directoryStat);
  chmodSync(directory, 0o700);
  writePrivateFileAtomic(filePath, normalizeToken(token));
  validatePrivateFile(filePath);
}

export function writePrivateFileAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
  }
}

export function validatePrivateFile(filePath) {
  const fileStat = lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Credential path must be a regular file: ${filePath}`);
  }
  validateOwner(filePath, fileStat);
  // Windows protects this path with an inherited user-only ACL in install.ps1.
  // POSIX mode bits are synthetic there and cannot prove access restrictions.
  if (process.platform === "win32") return;
  if ((fileStat.mode & 0o777) !== 0o600) {
    throw new Error(`Credential file must have mode 0600: ${filePath}`);
  }
}

export function validateApiUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("Recall Cloud API URL is invalid");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username
    || url.password) {
    throw new Error("Recall Cloud API must use HTTPS (or loopback HTTP) without URL credentials");
  }
  return url.href.replace(/\/$/, "");
}

function validateOwner(filePath, fileStat) {
  if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) {
    throw new Error(`Credential path must be owned by the current user: ${filePath}`);
  }
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
