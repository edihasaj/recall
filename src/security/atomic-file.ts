import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export function readUtf8FileIfExists(path: string): string | null {
  let fd: number;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }

  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`Refusing to read non-file path: ${path}`);
    }
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteUtf8File(
  path: string,
  content: string,
  mode = 0o600,
): void {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode,
    );
    writeFileSync(fd, content, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
