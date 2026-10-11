import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DependencyError, PersistenceError, ValidationError } from '../src/core/errors.js';
import { readJsonFile, writeJsonFileAtomic } from '../src/persistence/jsonFile.js';
import { ProjectRepository } from '../src/persistence/projectRepository.js';
import { makeTask, makeTempDir, sampleProject } from './helpers.js';

describe('JSON persistence', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('round-trips project spec and tasks', async () => {
    const repo = new ProjectRepository(path.join(dir, '.factory'));
    const tasks = [
      makeTask('A', { status: 'completed', results: [{ attempt: 1, outcome: 'success', startedAt: 's', finishedAt: 'f', summary: 'ok' }] }),
      makeTask('B', { dependencies: ['A'] }),
    ];
    await repo.saveProject(sampleProject);
    await repo.saveTasks(tasks);
    assert.deepEqual(await repo.loadProject(), sampleProject);
    assert.deepEqual(await repo.loadTasks(), tasks);
  });

  it('writes stable, diff-friendly JSON with a schema version', async () => {
    const repo = new ProjectRepository(dir);
    await repo.saveTasks([makeTask('A')]);
    const text = await readFile(repo.tasksFile, 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.match(text, /^\{\n {2}"schemaVersion": 1,/);
  });

  it('leaves no temp files behind after writing', async () => {
    await writeJsonFileAtomic(path.join(dir, 'a.json'), { x: 1 });
    await writeJsonFileAtomic(path.join(dir, 'a.json'), { x: 2 });
    assert.deepEqual(await readdir(dir), ['a.json']);
    assert.deepEqual(await readJsonFile(path.join(dir, 'a.json'), (r) => r), { x: 2 });
  });

  it('reports a missing file as a PersistenceError', async () => {
    const repo = new ProjectRepository(dir);
    await assert.rejects(repo.loadTasks(), (err: unknown) => err instanceof PersistenceError && /does not exist/.test(err.message));
  });

  it('reports malformed JSON as a PersistenceError', async () => {
    const repo = new ProjectRepository(dir);
    await writeFile(repo.tasksFile, '{ "schemaVersion": 1, "tasks": [ ', 'utf8');
    await assert.rejects(repo.loadTasks(), PersistenceError);
  });

  it('accepts a UTF-8 BOM written by Windows editors', async () => {
    const repo = new ProjectRepository(dir);
    await writeFile(repo.projectFile, `﻿${JSON.stringify(sampleProject)}`, 'utf8');
    assert.deepEqual(await repo.loadProject(), sampleProject);
  });

  it('rejects unsupported schema versions and invalid tasks on load', async () => {
    const repo = new ProjectRepository(dir);
    await writeFile(repo.tasksFile, JSON.stringify({ schemaVersion: 99, tasks: [] }), 'utf8');
    await assert.rejects(repo.loadTasks(), ValidationError);
    await writeFile(repo.tasksFile, JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'A' }] }), 'utf8');
    await assert.rejects(repo.loadTasks(), (err: unknown) => err instanceof ValidationError && err.message.includes(repo.tasksFile));
  });

  it('rejects a cyclic graph on load', async () => {
    const repo = new ProjectRepository(dir);
    const tasks = [makeTask('A', { dependencies: ['B'] }), makeTask('B', { dependencies: ['A'] })];
    await writeFile(repo.tasksFile, JSON.stringify({ schemaVersion: 1, tasks }), 'utf8');
    await assert.rejects(repo.loadTasks(), DependencyError);
  });

  it('refuses to save invalid tasks and keeps the previous file intact', async () => {
    const repo = new ProjectRepository(dir);
    await repo.saveTasks([makeTask('A')]);
    const before = await readFile(repo.tasksFile, 'utf8');
    await assert.rejects(repo.saveTasks([makeTask('A', { dependencies: ['missing'] })]), DependencyError);
    await assert.rejects(repo.saveTasks([{ ...makeTask('B'), title: '' }]), ValidationError);
    assert.equal(await readFile(repo.tasksFile, 'utf8'), before);
  });
});
