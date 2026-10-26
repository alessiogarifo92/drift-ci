import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.ts';

const repos: FixtureRepo[] = [];
function repoFor(caseName: string): FixtureRepo {
  const repo = createFixtureRepo(caseName);
  repos.push(repo);
  return repo;
}
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** path → bytes for every file under `dir`, with the helper's renames applied. */
function filesOnDisk(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(dir, path).replace(/(^|\/)_gitignore$/, '$1.gitignore');
      files.set(rel, readFileSync(path));
    }
  };
  walk(dir);
  return files;
}

/** Raw bytes of `path` as committed in `rev`. */
function blob(repo: FixtureRepo, rev: string, path: string): Buffer {
  return execFileSync('git', ['cat-file', 'blob', `${rev}:${path}`], { cwd: repo.dir });
}

/** path → bytes for every file in the tree of `rev`. */
function filesInCommit(repo: FixtureRepo, rev: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const listing = repo.git('ls-tree', '-r', '-z', '--name-only', rev);
  for (const path of listing.split('\0').filter(Boolean)) files.set(path, blob(repo, rev, path));
  return files;
}

describe('createFixtureRepo', () => {
  it('commits base/ as HEAD^ and head/ as HEAD', () => {
    const repo = repoFor('sample');

    expect(repo.git('rev-parse', 'HEAD^')).toBe(repo.baseSha);
    expect(repo.git('rev-parse', 'HEAD')).toBe(repo.headSha);
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toEqual([
      repo.headSha,
      repo.baseSha,
    ]);

    const base = filesOnDisk(join(FIXTURES_DIR, 'sample', 'base'));
    const head = filesOnDisk(join(FIXTURES_DIR, 'sample', 'head'));
    expect(filesInCommit(repo, 'HEAD^')).toEqual(base);
    expect(filesInCommit(repo, 'HEAD')).toEqual(head);
  });

  it('records the base → head change as a rename', () => {
    const repo = repoFor('sample');
    const diff = repo.git('diff', '-M', '--name-status', 'HEAD^', 'HEAD');
    expect(diff.split('\n')).toEqual(
      expect.arrayContaining(['A\t.gitignore', expect.stringMatching(/^R100\tsrc\/old\.ts\tlib\/new\.ts$/)]),
    );
  });

  it('turns _gitignore into a real .gitignore', () => {
    const repo = repoFor('sample');
    expect(repo.git('show', 'HEAD:.gitignore')).toBe('build/');
    expect(repo.git('ls-tree', '--name-only', 'HEAD')).not.toContain('_gitignore');
  });

  it('keeps CRLF line endings byte-exact', () => {
    const repo = repoFor('crlf');
    expect(blob(repo, 'HEAD^', 'NOTES.md').toString('utf8')).toBe('line one\r\nsee `src/a.ts`\r\n');
    expect(blob(repo, 'HEAD', 'NOTES.md').toString('utf8')).toBe('line one\r\nsee `src/b.ts`\r\n');
  });

  it('treats a missing head/ as an empty tree', () => {
    const repo = repoFor('delete-all');
    expect(repo.git('ls-tree', '-r', '--name-only', 'HEAD^')).toBe('file.txt');
    expect(repo.git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('produces identical commits for identical fixtures', () => {
    expect(repoFor('sample').headSha).toBe(repoFor('sample').headSha);
  });

  it('throws for an unknown fixture', () => {
    expect(() => createFixtureRepo('does-not-exist')).toThrow(/fixture not found/);
  });

  it('throws for a directory with neither base/ nor head/', () => {
    expect(() => createFixtureRepo(join(FIXTURES_DIR, 'sample', 'base'))).toThrow(
      /needs base\/ or head\//,
    );
  });

  it('rejects a fixture whose base is a file and leaves no temp repo behind', () => {
    const caseDir = mkdtempSync(join(tmpdir(), 'drift-case-'));
    const parentDir = mkdtempSync(join(tmpdir(), 'drift-parent-'));
    try {
      writeFileSync(join(caseDir, 'base'), 'not a directory');
      mkdirSync(join(caseDir, 'head'));
      expect(() => createFixtureRepo(caseDir, { parentDir })).toThrow(/not a directory/);
      expect(readdirSync(parentDir)).toEqual([]);
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('creates the repository under parentDir when given', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'drift-parent-'));
    try {
      const repo = createFixtureRepo('sample', { parentDir });
      expect(repo.dir.startsWith(parentDir)).toBe(true);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
