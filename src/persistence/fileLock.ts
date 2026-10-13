import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LockHeldError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { isProcessAlive } from '../security/processTree.js';

export const LOCK_FILE = 'factory.lock';
export const STALE_LOCK_DIR = 'stale-locks';

export interface LockInfo {
  pid: number;
  hostname: string;
  token: string;
  acquiredAt: string;
  command: string;
}

export type LockState =
  | { state: 'free' }
  | { state: 'held'; info: LockInfo; owner: 'alive' | 'dead' | 'unknown-host' }
  | { state: 'unreadable'; detail: string };

export interface LockHandle {
  readonly info: LockInfo;
  release(): Promise<void>;
}

/**
 * Cross-process exclusive lock for a task store, implemented as a lock file
 * created with O_CREAT|O_EXCL (`wx`). Creation is atomic on local NTFS and
 * POSIX file systems, so exactly one process can hold it.
 *
 * Stale locks are never broken automatically. `breakStaleLock` only archives
 * a lock whose owner is on this host and confirmed dead, and is reached only
 * through the explicit `recover` command.
 */
export class FileLock {
  readonly lockPath: string;

  constructor(readonly dataDir: string) {
    this.lockPath = path.join(dataDir, LOCK_FILE);
  }

  async acquire(command: string): Promise<LockHandle> {
    const info: LockInfo = {
      pid: process.pid,
      hostname: os.hostname(),
      token: randomBytes(16).toString('hex'),
      acquiredAt: new Date().toISOString(),
      command,
    };
    await mkdir(this.dataDir, { recursive: true });
    let handle;
    try {
      handle = await open(this.lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new LockHeldError(await this.describeHolder());
      throw err;
    }
    try {
      await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    let released = false;
    return {
      info,
      release: async () => {
        if (released) return;
        released = true;
        // Only remove the lock if it is still ours.
        const current = await this.inspect();
        if (current.state === 'held' && current.info.token === info.token) await unlink(this.lockPath);
      },
    };
  }

  /** Throw unless the lock file still holds `info`'s token (used when a caller passes in a held lock). */
  async assertHeld(info: LockInfo): Promise<void> {
    const state = await this.inspect();
    if (state.state !== 'held' || state.info.token !== info.token) {
      throw new LockHeldError(`This process no longer holds ${this.lockPath}; refusing to modify state.`);
    }
  }

  async inspect(): Promise<LockState> {
    let text: string;
    try {
      text = await readFile(this.lockPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'free' };
      return { state: 'unreadable', detail: (err as Error).message };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { state: 'unreadable', detail: 'lock file is empty or not valid JSON (a writer may have crashed while creating it)' };
    }
    if (
      !isRecord(raw) ||
      typeof raw.pid !== 'number' ||
      typeof raw.hostname !== 'string' ||
      typeof raw.token !== 'string' ||
      typeof raw.acquiredAt !== 'string' ||
      typeof raw.command !== 'string'
    ) {
      return { state: 'unreadable', detail: 'lock file has an unexpected format' };
    }
    const info: LockInfo = {
      pid: raw.pid,
      hostname: raw.hostname,
      token: raw.token,
      acquiredAt: raw.acquiredAt,
      command: raw.command,
    };
    if (info.hostname !== os.hostname()) return { state: 'held', info, owner: 'unknown-host' };
    return { state: 'held', info, owner: isProcessAlive(info.pid) ? 'alive' : 'dead' };
  }

  /**
   * Archive (never delete) a lock whose owner process is confirmed dead on this
   * host. Returns the archive path. Refuses in every other case.
   */
  async breakStaleLock(): Promise<string> {
    const state = await this.inspect();
    if (state.state === 'free') throw new LockHeldError('No lock to break.');
    if (state.state === 'unreadable') {
      throw new LockHeldError(
        `Lock file ${this.lockPath} is unreadable (${state.detail}). Confirm no factory process is running, then move the file away manually.`,
      );
    }
    if (state.owner !== 'dead') throw new LockHeldError(await this.describeHolder());
    const archiveDir = path.join(this.dataDir, STALE_LOCK_DIR);
    await mkdir(archiveDir, { recursive: true });
    const archive = path.join(archiveDir, `${LOCK_FILE}.${state.info.token}`);
    // Re-check right before moving to narrow the window for a racing recover.
    const again = await this.inspect();
    if (again.state !== 'held' || again.info.token !== state.info.token) {
      throw new LockHeldError('Lock changed while recovering; run recover again.');
    }
    await rename(this.lockPath, archive);
    return archive;
  }

  private async describeHolder(): Promise<string> {
    const state = await this.inspect();
    if (state.state === 'free') return `Lock ${this.lockPath} was released while checking; try again.`;
    if (state.state === 'unreadable') {
      let age = '';
      try {
        age = ` (modified ${(await stat(this.lockPath)).mtime.toISOString()})`;
      } catch {
        /* ignore */
      }
      return `Task store is locked but the lock file is unreadable${age}: ${state.detail}. If no factory process is running, move ${this.lockPath} away manually.`;
    }
    const { info, owner } = state;
    const who = `pid ${info.pid} on ${info.hostname}, "${info.command}" since ${info.acquiredAt}`;
    if (owner === 'alive') return `Task store is locked by a running factory process (${who}).`;
    if (owner === 'dead') {
      return `Task store is locked by a factory process that is no longer running (${who}). Run "recover" to release the stale lock and mark interrupted tasks.`;
    }
    return `Task store is locked by a process on another host (${who}). Liveness cannot be checked from here; remove the lock manually only after confirming that process has stopped.`;
  }
}
