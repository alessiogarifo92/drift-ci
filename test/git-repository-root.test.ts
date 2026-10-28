import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError } from '../src/git/errors.ts';
import { repositoryRoot } from '../src/git/revision.ts';
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.ts';

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoFor(caseName: string): FixtureRepo {
  const repo = createFixtureRepo(caseName);
  repos.push(repo);
  return repo;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-root-'));
  dirs.push(dir);
  return dir;
}

describe('repositoryRoot', () => {
  it('returns the top level from the root and from a nested directory', async () => {
    const repo = repoFor('sample');
    const root = realpathSync(repo.dir);
    const nested = join(repo.dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(await repositoryRoot(repo.dir)).toBe(root);
    expect(await repositoryRoot(nested)).toBe(root);
  });

  it('is the directory itself for a bare repository', async () => {
    const repo = repoFor('sample');
    const bare = join(scratch(), 'bare.git');
    execFileSync('git', ['clone', '--quiet', '--bare', repo.dir, bare], { stdio: 'ignore' });
    expect(await repositoryRoot(bare)).toBe(bare);
  });

  it('rejects with GitError outside a repository', async () => {
    await expect(repositoryRoot(scratch())).rejects.toBeInstanceOf(GitError);
  });

  it('rejects with GitError for a directory that does not exist', async () => {
    await expect(repositoryRoot('/nonexistent-drift-ci-dir')).rejects.toThrow(/does not exist/);
  });
});
