import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FactoryError, PersistenceError } from '../core/errors.js';

/**
 * Read and parse a JSON file, then validate it with `parse`. Missing files,
 * malformed JSON and validation failures all surface as typed errors.
 */
export async function readJsonFile<T>(filePath: string, parse: (raw: unknown) => T): Promise<T> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'file does not exist' : `read failed (${code ?? 'unknown error'})`;
    throw new PersistenceError(`Cannot read ${filePath}: ${reason}`, { cause: err });
  }
  let raw: unknown;
  try {
    // Strip a UTF-8 BOM, which Windows editors such as Notepad may add.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new PersistenceError(`Cannot parse ${filePath}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return parse(raw);
  } catch (err) {
    if (err instanceof FactoryError) {
      err.message = `${filePath}: ${err.message}`;
      throw err;
    }
    throw new PersistenceError(`Invalid content in ${filePath}`, { cause: err });
  }
}

/**
 * Write JSON atomically: serialize to a uniquely named temp file in the same
 * directory, then rename over the target. Readers never observe a half-written
 * file. Output is pretty-printed with a trailing newline to keep diffs clean.
 */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, filePath);
  } catch (err) {
    // Only ever removes the temp file this call created; never the target.
    await unlink(tempPath).catch(() => undefined);
    throw new PersistenceError(`Cannot write ${filePath}: ${(err as Error).message}`, { cause: err });
  }
}
