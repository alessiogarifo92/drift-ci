import { afterAll, describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli/main.ts';
import type { CheckResult } from '../src/core/finding.ts';
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.ts';

function capture(cwd: string): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    cwd,
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

const repos: FixtureRepo[] = [];
afterAll(() => repos.forEach((repo) => repo.cleanup()));
function repoFor(name: string): FixtureRepo {
  const repo = createFixtureRepo(name);
  repos.push(repo);
  return repo;
}

describe('drift-ci check with a .drift-ci.yml in the head commit', () => {
  it('reports the path drift once the config file is gone (control)', async () => {
    const repo = repoFor('config-disabled-paths');
    repo.git('rm', '--quiet', '.drift-ci.yml');
    repo.git('commit', '--quiet', '-m', 'drop the config');
    const io = capture(repo.dir);
    expect(await run(['--base', repo.baseSha], io)).toBe(0);
    expect(io.out).toMatch(/^README\.md:3:15 .*\n1 finding\n$/);
  });

  it('finds no path drift when the config disables checks.paths', async () => {
    const repo = repoFor('config-disabled-paths');
    const io = capture(repo.dir);
    expect(await run([], io)).toBe(0);
    expect(io.out).toBe('0 findings\n');
    expect(io.err).toBe('');
  });

  it('exits 2 with a one-line message naming the file when the config is invalid', async () => {
    const repo = repoFor('config-invalid');
    const io = capture(repo.dir);
    expect(await run([], io)).toBe(2);
    expect(io.err).toBe('drift-ci: .drift-ci.yml: version must be 1, got 2\n');
    expect(io.out).toBe('');
  });

  it('applies docs excludes and ignore entries, and carries failOn in the JSON result', async () => {
    const repo = repoFor('config-ignore');
    const io = capture(repo.dir);
    expect(await run(['--format', 'json'], io)).toBe(0);
    const result = JSON.parse(io.out) as CheckResult;
    // docs/CHANGELOG.md is excluded by default and docs/guide.md is ignored: only the README remains.
    expect(result.findings.map((f) => f.file)).toEqual(['README.md']);
    expect(result.failOn).toBe('warning');
    expect(result.schemaVersion).toBe(1);
  });
});
