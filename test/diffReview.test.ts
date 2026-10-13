import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_EXECUTION } from '../src/config/factoryConfig.js';
import { parseRawDiff } from '../src/git/gitWorkspace.js';
import type { ChangedFile } from '../src/persistence/runStore.js';
import { isSensitivePath, reviewChanges } from '../src/review/diffReview.js';

const file = (path: string, status = 'M', mode = '100644', oldPath?: string): ChangedFile => ({
  status,
  path,
  mode,
  ...(oldPath !== undefined ? { oldPath } : {}),
});
const review = (changedFiles: ChangedFile[], extra: { patch?: string; ignored?: string[]; policy?: Partial<typeof DEFAULT_EXECUTION> } = {}) =>
  reviewChanges({
    changedFiles,
    patch: extra.patch ?? '+ok\n',
    ignoredFiles: extra.ignored ?? [],
    dataDirRel: '.factory',
    policy: { ...DEFAULT_EXECUTION, ...(extra.policy ?? {}) },
  });
const rules = (findings: ReturnType<typeof review>, severity = 'violation') =>
  findings.filter((f) => f.severity === severity).map((f) => f.rule);

describe('diff review', () => {
  it('passes a normal change', () => {
    assert.deepEqual(review([file('src/a.ts'), file('test/a.test.ts', 'A')]), []);
  });

  it('flags empty changes, size and file-count limits', () => {
    assert.deepEqual(rules(review([])), ['no-changes']);
    assert.ok(rules(review([file('a'), file('b')], { policy: { maxChangedFiles: 1 } })).includes('too-many-files'));
    assert.ok(rules(review([file('a')], { patch: 'x'.repeat(2000), policy: { maxDiffBytes: 1024 } })).includes('diff-too-large'));
  });

  it('flags protected paths, including the data dir and renamed sources', () => {
    for (const p of ['.git/config', 'sub/.git/hooks/x', '.github/workflows/ci.yml', '.claude/settings.json', '.factory/tasks.json', '.gitattributes']) {
      assert.ok(rules(review([file(p)])).includes('protected-path'), p);
    }
    assert.ok(rules(review([file('src/x.ts', 'R', '100644', '.github/x.ts')])).includes('protected-path'));
    assert.ok(rules(review([file('deploy/prod.yml')], { policy: { protectedPaths: ['deploy'] } })).includes('protected-path'));
  });

  it('flags sensitive files, symlinks, submodules, deletions and scope', () => {
    for (const p of ['.env', 'config/.env.local', 'certs/server.key', 'id_rsa', '.npmrc', 'aws-credentials.json', 'secrets.yaml']) {
      assert.equal(isSensitivePath(p), true, p);
    }
    assert.equal(isSensitivePath('src/environment.ts'), false);
    assert.ok(rules(review([file('link', 'A', '120000')])).includes('symlink'));
    assert.ok(rules(review([file('vendor/lib', 'A', '160000')])).includes('submodule'));
    assert.ok(rules(review([file('old.ts', 'D')])).includes('deletion'));
    assert.deepEqual(rules(review([file('old.ts', 'D')], { policy: { allowDeletions: true } })), []);
    assert.ok(rules(review([file('docs/x.md')], { policy: { allowedPaths: ['src', 'test/'] } })).includes('out-of-scope'));
    assert.deepEqual(rules(review([file('src/x.ts')], { policy: { allowedPaths: ['src'] } })), []);
  });

  it('flags secret-looking added content but not ordinary code', () => {
    assert.ok(rules(review([file('a.ts')], { patch: '+const k = "sk-ant-api03-abcdefghijklmnop";\n' })).includes('secret-content'));
    assert.ok(rules(review([file('a.ts')], { patch: '+password = "hunter2hunter2"\n' })).includes('secret-content'));
    assert.deepEqual(rules(review([file('a.ts')], { patch: '+  token: string;\n+const secret = getSecret();\n' })), []);
    assert.deepEqual(rules(review([file('a.ts')], { patch: '-const k = "sk-ant-api03-abcdefghijklmnop";\n' })), []);
  });

  it('reports ignored files, escalating sensitive ones', () => {
    const findings = review([file('a.ts')], { ignored: ['build/out.js', '.env'] });
    assert.deepEqual(rules(findings), ['sensitive-ignored-file']);
    assert.deepEqual(rules(findings, 'warning'), ['ignored-files']);
  });

  it('parses git --raw -z output including renames and deletions', () => {
    const raw = [
      ':100644 100644 aaaa bbbb M', 'src/a.ts',
      ':000000 100644 0000 cccc A', 'src/new file.ts',
      ':100644 000000 dddd 0000 D', 'old.ts',
      ':100644 100644 eeee ffff R095', 'from.ts', 'to.ts',
      ':000000 120000 0000 1111 A', 'link',
      '',
    ].join('\0');
    assert.deepEqual(parseRawDiff(raw), [
      { status: 'M', path: 'src/a.ts', mode: '100644' },
      { status: 'A', path: 'src/new file.ts', mode: '100644' },
      { status: 'D', path: 'old.ts', mode: '100644' },
      { status: 'R', path: 'to.ts', oldPath: 'from.ts', mode: '100644' },
      { status: 'A', path: 'link', mode: '120000' },
    ]);
  });
});
