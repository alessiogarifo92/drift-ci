import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError, GitNotFoundError, UnknownRevisionError } from '../src/git/errors.ts';
import { runGit } from '../src/git/run.ts';
import { computeChangeSet } from '../src/git/changeset.ts';
import { openSnapshot } from '../src/git/snapshot.ts';
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.ts';

const repos: FixtureRepo[] = [];
const tempDirs: string[] = [];
function repoFor(caseName: string): FixtureRepo {
  const repo = createFixtureRepo(caseName);
  repos.push(repo);
  return repo;
}
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const UNKNOWN_SHA = '0123456789012345678901234567890123456789';

describe('runGit', () => {
  it('returns stdout as bytes, stderr as text and the exit code', async () => {
    const repo = repoFor('sample');
    const result = await runGit(repo.dir, ['rev-parse', 'HEAD']);
    expect(result.stdout.toString('utf8').trim()).toBe(repo.headSha);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('feeds stdin to the process', async () => {
    const repo = repoFor('sample');
    const result = await runGit(repo.dir, ['cat-file', '--batch-check'], { input: `${repo.headSha}\n` });
    expect(result.stdout.toString('utf8')).toMatch(new RegExp(`^${repo.headSha} commit \\d+\\n$`));
  });

  it('throws GitError with the stderr and exit code on a non-zero exit', async () => {
    const repo = repoFor('sample');
    const error = await runGit(repo.dir, ['cat-file', '-t', UNKNOWN_SHA]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).not.toBeInstanceOf(GitNotFoundError);
    const gitError = error as GitError;
    expect(gitError.exitCode).toBe(128);
    expect(gitError.stderr).toMatch(/fatal/);
    expect(gitError.message).toMatch(/cat-file -t/);
    expect(gitError.message).toMatch(/fatal/);
  });

  it('accepts listed exit codes as a result instead of an error', async () => {
    const repo = repoFor('sample');
    const result = await runGit(repo.dir, ['grep', '-F', '-e', 'no-such-word-anywhere', 'HEAD'], {
      okExitCodes: [1],
    });
    expect(result.exitCode).toBe(1);
  });

  it('throws GitNotFoundError when the git binary does not exist', async () => {
    const repo = repoFor('sample');
    const error = await runGit(repo.dir, ['status'], { gitBinary: '/nonexistent/git' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitNotFoundError);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitNotFoundError).gitBinary).toBe('/nonexistent/git');
    expect((error as GitNotFoundError).message).toMatch(/\/nonexistent\/git/);
  });

  it('reports a git binary that cannot be executed as a GitError, not as a missing git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-notexec-'));
    tempDirs.push(dir);
    const notExecutable = join(dir, 'git');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
    const error = await runGit(dir, ['status'], { gitBinary: notExecutable }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).not.toBeInstanceOf(GitNotFoundError);
    expect((error as GitError).message).toMatch(/failed to start/);
  });

  it('reports a git killed by a signal as a GitError without an exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-signal-'));
    tempDirs.push(dir);
    const fakeGit = join(dir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    const error = await runGit(dir, ['status'], { gitBinary: fakeGit }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).exitCode).toBeUndefined();
    expect((error as GitError).message).toMatch(/signal/);
  });

  it('reports a missing repository directory as a GitError, not as a missing git', async () => {
    const missing = join(tmpdir(), 'drift-does-not-exist-dir');
    const error = await runGit(missing, ['status']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).not.toBeInstanceOf(GitNotFoundError);
    expect((error as GitError).message).toMatch(/does not exist/);
  });

  it('ignores GIT_DIR from the environment: the repository is the given directory', async () => {
    const repo = repoFor('sample');
    const other = repoFor('crlf');
    const previous = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(other.dir, '.git');
    try {
      const result = await runGit(repo.dir, ['rev-parse', 'HEAD']);
      expect(result.stdout.toString('utf8').trim()).toBe(repo.headSha);
    } finally {
      if (previous === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previous;
    }
  });
});

describe('openSnapshot errors', () => {
  it('throws UnknownRevisionError for an unknown SHA', async () => {
    const repo = repoFor('sample');
    const error = await openSnapshot(repo.dir, UNKNOWN_SHA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownRevisionError);
    expect(error).toBeInstanceOf(GitError);
    expect((error as UnknownRevisionError).rev).toBe(UNKNOWN_SHA);
    expect((error as UnknownRevisionError).message).toContain(UNKNOWN_SHA);
  });

  it('throws UnknownRevisionError for an unknown ref name', async () => {
    const repo = repoFor('sample');
    await expect(openSnapshot(repo.dir, 'refs/heads/nope')).rejects.toBeInstanceOf(UnknownRevisionError);
  });

  it('treats a revision that looks like an option as a revision, not as an option', async () => {
    const repo = repoFor('sample');
    const error = await openSnapshot(repo.dir, '--output=/tmp/drift-x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownRevisionError);
    expect((error as UnknownRevisionError).rev).toBe('--output=/tmp/drift-x');
  });

  it('throws GitNotFoundError when git is missing', async () => {
    const repo = repoFor('sample');
    await expect(openSnapshot(repo.dir, 'HEAD', { gitBinary: '/nonexistent/git' })).rejects.toBeInstanceOf(
      GitNotFoundError,
    );
  });

  it('throws a plain GitError, not UnknownRevisionError, outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-norepo-'));
    tempDirs.push(dir);
    const error = await openSnapshot(dir, 'HEAD').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).not.toBeInstanceOf(UnknownRevisionError);
    expect((error as GitError).stderr).toMatch(/not a git repository/);
  });

  it('resolves a branch name and an abbreviated SHA to the full commit SHA', async () => {
    const repo = repoFor('sample');
    expect((await openSnapshot(repo.dir, 'main')).commit).toBe(repo.headSha);
    expect((await openSnapshot(repo.dir, repo.baseSha.slice(0, 10))).commit).toBe(repo.baseSha);
    expect((await openSnapshot(repo.dir, 'HEAD^')).commit).toBe(repo.baseSha);
  });
});

describe('computeChangeSet errors', () => {
  it('throws UnknownRevisionError naming the revision that is missing', async () => {
    const repo = repoFor('sample');
    await expect(computeChangeSet(repo.dir, UNKNOWN_SHA, repo.headSha)).rejects.toMatchObject({
      name: 'UnknownRevisionError',
      rev: UNKNOWN_SHA,
    });
    await expect(computeChangeSet(repo.dir, repo.baseSha, 'nope')).rejects.toMatchObject({
      name: 'UnknownRevisionError',
      rev: 'nope',
    });
  });

  it('throws GitNotFoundError when git is missing', async () => {
    const repo = repoFor('sample');
    await expect(
      computeChangeSet(repo.dir, repo.baseSha, repo.headSha, { gitBinary: '/nonexistent/git' }),
    ).rejects.toBeInstanceOf(GitNotFoundError);
  });
});
