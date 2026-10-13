// Runs an autonomous run in a separate process for cross-process tests.
//
//   node autoChild.js <spec.json>
//
// spec: { dir, config, signalDir, hold?: { [taskId]: 'wait' | 'hang' } }
// The fake agent writes the chain files for each task, then creates
// <signalDir>/started-<taskId>. With 'wait' it blocks until
// <signalDir>/release-<taskId> exists; with 'hang' it never returns.
// The final record is written to <signalDir>/result.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFactoryConfig } from '../../src/config/factoryConfig.js';
import { AutonomousRunner } from '../../src/orchestrator/autonomousRunner.js';
import { Supervisor } from '../../src/orchestrator/supervisor.js';
import { FileLock } from '../../src/persistence/fileLock.js';
import { ProjectRepository } from '../../src/persistence/projectRepository.js';
import { FakeAgent, ok, writeChainWork } from '../gitFixture.js';

interface Spec {
  dir: string;
  config: Record<string, unknown>;
  signalDir: string;
  hold?: Record<string, 'wait' | 'hang'>;
}

const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Spec;
const config = parseFactoryConfig(spec.config, spec.dir);
const repository = new ProjectRepository(config.dataDir);
const lock = new FileLock(config.dataDir);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const agent = new FakeAgent(async (cwd, _hooks, request) => {
  const id = request!.task.id;
  await writeChainWork(cwd, id);
  writeFileSync(path.join(spec.signalDir, `started-${id}`), String(process.pid));
  const hold = spec.hold?.[id];
  if (hold === 'hang') await new Promise(() => setInterval(() => undefined, 1000));
  if (hold === 'wait') while (!existsSync(path.join(spec.signalDir, `release-${id}`))) await sleep(50);
  return ok(`implemented ${id}`);
});
const supervisor = new Supervisor({ config, repository, agent, lock });
const runner = new AutonomousRunner({ config, repository, supervisor, lock });
const record = await runner.start();
writeFileSync(path.join(spec.signalDir, 'result.json'), JSON.stringify(record));
