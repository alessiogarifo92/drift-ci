import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runScan } from '../src/git/pipeline.ts';
import { createFixtureRepo, FIXTURES_DIR, type FixtureRepo } from './helpers/fixture-repo.ts';

interface Expected {
  ruleId: string;
  file: string;
  line: number;
  col: number;
}

const repos: FixtureRepo[] = [];
afterAll(() => repos.forEach((repo) => repo.cleanup()));

describe('scan on fixture repositories', () => {
  it('scan-sample matches expected-scan.json and reports no env var, bin or resolved reference', async () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, 'scan-sample', 'expected-scan.json'), 'utf8')) as Expected[];
    const repo = createFixtureRepo('scan-sample');
    repos.push(repo);
    const result = await runScan(repo.dir, 'HEAD');
    expect(result.findings.map(({ ruleId, file, line, col }) => ({ ruleId, file, line, col }))).toEqual(expected);
    expect(result).toMatchObject({ schemaVersion: 1, mode: 'scan', head: repo.headSha, warnings: [], failOn: 'none' });
    expect(result.findings.map((f) => f.fact)).toEqual(['package.json#deploy', 'src/gone.ts', 'make:release']);
    expect(result.findings.some((f) => f.ruleId === 'env' || f.ruleId === 'bin')).toBe(false);
  });

  it('scans the commit it is given, not the working tree or HEAD', async () => {
    const repo = createFixtureRepo('scan-sample');
    repos.push(repo);
    // The README of the base (an empty tree) has nothing to flag; HEAD does.
    expect((await runScan(repo.dir, repo.baseSha)).findings).toEqual([]);
    expect((await runScan(repo.dir, repo.headSha)).findings).toHaveLength(3);
  });

  it('reads the config of the scanned commit', async () => {
    const repo = createFixtureRepo('scan-sample');
    repos.push(repo);
    writeFileSync(join(repo.dir, '.drift-ci.yml'), 'version: 1\nfailOn: warning\nchecks:\n  paths: false\n');
    repo.git('add', '--all');
    repo.git('commit', '--quiet', '--no-verify', '-m', 'config');
    const result = await runScan(repo.dir, 'HEAD');
    expect(result.failOn).toBe('warning');
    expect(result.findings.map((f) => f.ruleId)).toEqual(['npm-script', 'make-target']);
  });

  it('counts a same-repo GitHub URL as a path through the origin remote', async () => {
    const repo = createFixtureRepo('cli-github-url');
    repos.push(repo);
    repo.git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    expect((await runScan(repo.dir, 'HEAD')).findings.map((f) => f.ruleId)).toEqual(['path']);
    const bare = createFixtureRepo('cli-github-url');
    repos.push(bare);
    expect((await runScan(bare.dir, 'HEAD')).findings).toEqual([]);
  });
});
