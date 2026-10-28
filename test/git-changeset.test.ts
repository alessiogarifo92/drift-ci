import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeSet, Rename } from '../src/core/snapshot.ts';
import { computeChangeSet, parseNameStatus, renameLimitWarning } from '../src/git/changeset.ts';
import { GitError } from '../src/git/errors.ts';
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.ts';
import { commitWithIndexEntry, shallowClone, withOlderHistory } from './helpers/git-extras.ts';

const repos: FixtureRepo[] = [];
const cleanups: (() => void)[] = [];
function repoFor(caseName: string): FixtureRepo {
  const repo = createFixtureRepo(caseName);
  repos.push(repo);
  return repo;
}
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function changeSetOf(caseName: string): Promise<ChangeSet> {
  const repo = repoFor(caseName);
  return computeChangeSet(repo.dir, repo.baseSha, repo.headSha);
}

const rename = (from: string, to: string, similarity = 100): Rename => ({ from, to, similarity });
const empty: ChangeSet = {
  renamed: [],
  deleted: [],
  added: [],
  modified: [],
  renamedDirs: [],
  warnings: [],
};

describe('computeChangeSet: file changes', () => {
  it('reports a plain rename with similarity 100', async () => {
    expect(await changeSetOf('rename-plain')).toEqual({
      ...empty,
      renamed: [rename('src/old-name.ts', 'src/new-name.ts')],
    });
  });

  it('reports a rename with a small edit (more than 50% similar) as a rename', async () => {
    const changes = await changeSetOf('rename-edit-high');
    expect(changes.renamed).toHaveLength(1);
    const [renamed] = changes.renamed;
    expect(renamed).toMatchObject({ from: 'docs/setup.md', to: 'docs/install.md' });
    expect(renamed?.similarity).toBeGreaterThan(50);
    expect(renamed?.similarity).toBeLessThan(100);
    expect(changes.added).toEqual([]);
    expect(changes.deleted).toEqual([]);
  });

  it('reports a rewrite (less than 50% similar) as a deletion plus an addition', async () => {
    expect(await changeSetOf('rename-edit-low')).toEqual({
      ...empty,
      deleted: ['notes/draft.md'],
      added: ['notes/final.md'],
    });
  });

  it('reports unrelated delete and add, and leaves untouched files out', async () => {
    expect(await changeSetOf('delete-add')).toEqual({ ...empty, deleted: ['old.txt'], added: ['new.txt'] });
  });

  it('reports files changed in place as modified and sorts every list', async () => {
    const changes = await changeSetOf('sample');
    expect(changes).toEqual({
      ...empty,
      renamed: [rename('src/old.ts', 'lib/new.ts')],
      added: ['.gitignore'],
      modified: expect.any(Array),
    });
    expect(changes.modified).toEqual([...changes.modified].sort());
  });

  it('reports a whole-tree deletion', async () => {
    expect(await changeSetOf('delete-all')).toEqual({ ...empty, deleted: ['file.txt'] });
  });

  it('returns an empty change set when base and head are the same commit', async () => {
    const repo = repoFor('sample');
    expect(await computeChangeSet(repo.dir, repo.headSha, repo.headSha)).toEqual(empty);
  });

  it('accepts refs and abbreviated SHAs for base and head', async () => {
    const repo = repoFor('rename-plain');
    const byRef = await computeChangeSet(repo.dir, 'HEAD^', 'HEAD');
    const byShort = await computeChangeSet(repo.dir, repo.baseSha.slice(0, 8), 'main');
    expect(byRef).toEqual(byShort);
    expect(byRef.renamed).toHaveLength(1);
  });

  it('keeps names with spaces, unicode and emoji exactly as committed', async () => {
    const changes = await changeSetOf('unicode-names');
    expect(changes.renamed).toEqual([
      rename('emoji 🚀/notes.md', 'emoji 🚀/old notes.md'),
      rename('my docs/Guía rápida.md', 'my docs/Guía nueva.md'),
      rename('日本語/ファイル.md', '日本語/新しい.md'),
    ]);
    expect(changes.renamedDirs).toEqual([]);
    expect(changes.warnings).toEqual([]);
  });

  it('reports a file replaced by a symlink as modified', async () => {
    const repo = repoFor('rename-plain');
    const sha = commitWithIndexEntry(repo, {
      mode: '120000',
      oid: repo.git('rev-parse', 'HEAD:README.md'),
      path: 'README.md',
    });
    const changes = await computeChangeSet(repo.dir, repo.headSha, sha);
    expect(changes).toEqual({ ...empty, modified: ['README.md'] });
  });

  it('reports a submodule gitlink being added and removed', async () => {
    const repo = repoFor('submodule');
    const withLink = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'vendor/lib' });
    expect(await computeChangeSet(repo.dir, repo.headSha, withLink)).toEqual({
      ...empty,
      added: ['vendor/lib'],
    });
    expect(await computeChangeSet(repo.dir, withLink, repo.headSha)).toEqual({
      ...empty,
      deleted: ['vendor/lib'],
    });
  });

  it('reports a moved submodule as a rename and derives its directory', async () => {
    const repo = repoFor('submodule');
    const withLink = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'vendor/lib' });
    repo.git('rm', '--cached', '--quiet', 'vendor/lib');
    const moved = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'third_party/lib' });
    const changes = await computeChangeSet(repo.dir, withLink, moved);
    expect(changes.renamed).toEqual([rename('vendor/lib', 'third_party/lib')]);
    expect(changes.renamedDirs).toEqual([rename('vendor', 'third_party')]);
  });
});

describe('computeChangeSet: directory renames', () => {
  it('derives a directory rename when every file under it moved', async () => {
    const changes = await changeSetOf('dir-rename');
    expect(changes.renamed.map((r) => [r.from, r.to])).toEqual([
      ['docs/intro.md', 'guides/intro.md'],
      ['docs/usage.md', 'guides/usage.md'],
    ]);
    expect(changes.renamedDirs).toEqual([rename('docs', 'guides')]);
    expect(changes.modified).toEqual([]);
  });

  it('does not derive one when part of the directory stayed behind', async () => {
    const changes = await changeSetOf('dir-rename-partial');
    expect(changes.renamed).toEqual([rename('docs/a.md', 'guides/a.md')]);
    expect(changes.renamedDirs).toEqual([]);
  });

  it('reports only the outermost directory of a nested move', async () => {
    const changes = await changeSetOf('dir-rename-nested');
    expect(changes.renamed).toHaveLength(3);
    expect(changes.renamedDirs).toEqual([rename('src', 'lib')]);
  });

  it('keeps an inner directory that moved somewhere its parent did not', async () => {
    const changes = await changeSetOf('dir-rename-nested-split');
    expect(changes.renamed).toHaveLength(2);
    expect(changes.renamedDirs).toEqual([rename('src/app/ui', 'widgets')]);
  });
});

describe('computeChangeSet: diff.renameLimit', () => {
  it('detects renames with the raised default limit and warns about nothing', async () => {
    const changes = await changeSetOf('rename-limit');
    expect(changes.renamed.map((r) => r.to)).toEqual(['pkg/n1.txt', 'pkg/n2.txt', 'pkg/n3.txt']);
    expect(changes.warnings).toEqual([]);
  });

  it('warns, with git\'s suggested limit, when a low limit drops the renames', async () => {
    const repo = repoFor('rename-limit');
    const changes = await computeChangeSet(repo.dir, repo.baseSha, repo.headSha, { renameLimit: 1 });
    expect(changes.renamed).toEqual([]);
    expect(changes.deleted).toEqual(['pkg/f1.txt', 'pkg/f2.txt', 'pkg/f3.txt']);
    expect(changes.added).toEqual(['pkg/n1.txt', 'pkg/n2.txt', 'pkg/n3.txt']);
    expect(changes.warnings).toHaveLength(1);
    expect(changes.warnings[0]).toMatch(/rename detection was skipped/);
    expect(changes.warnings[0]).toContain('diff.renameLimit=1');
    expect(changes.warnings[0]).toMatch(/at least 3/);
  });

  it('ignores a renameLimit configured in the repository', async () => {
    const repo = repoFor('rename-limit');
    repo.git('config', 'diff.renameLimit', '1');
    const changes = await computeChangeSet(repo.dir, repo.baseSha, repo.headSha);
    expect(changes.renamed).toHaveLength(3);
    expect(changes.warnings).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid limit %s', async (renameLimit) => {
    const repo = repoFor('sample');
    await expect(computeChangeSet(repo.dir, repo.baseSha, repo.headSha, { renameLimit })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('computeChangeSet on a shallow clone', () => {
  it('diffs the two commits a fetch-depth: 2 checkout has', async () => {
    const repo = repoFor('dir-rename');
    const { baseSha, headSha, rootSha } = withOlderHistory(repo);
    const clone = shallowClone(repo, 2);
    cleanups.push(clone.cleanup);

    const changes = await computeChangeSet(clone.dir, 'HEAD^', 'HEAD');
    expect(changes.renamedDirs).toEqual([rename('docs', 'guides')]);
    expect(changes.renamed).toHaveLength(2);
    expect(changes).toEqual(await computeChangeSet(repo.dir, baseSha, headSha));

    // The commit before base is cut off by the shallow boundary.
    await expect(computeChangeSet(clone.dir, rootSha, 'HEAD')).rejects.toMatchObject({
      name: 'UnknownRevisionError',
      rev: rootSha,
    });
  });
});

describe('parseNameStatus', () => {
  const z = (...fields: string[]) => Buffer.from(fields.map((f) => `${f}\0`).join(''), 'utf8');

  it('parses every status git emits for base..head', () => {
    const parsed = parseNameStatus(
      z('A', 'new.md', 'D', 'gone.md', 'M', 'edited.md', 'T', 'typed.md', 'R087', 'a.md', 'b.md'),
    );
    expect(parsed).toEqual({
      added: ['new.md'],
      deleted: ['gone.md'],
      modified: ['edited.md', 'typed.md'],
      renamed: [rename('a.md', 'b.md', 87)],
    });
  });

  it('keeps newlines, tabs and spaces inside paths', () => {
    const parsed = parseNameStatus(z('A', 'two\nlines.md', 'R100', 'tab\there.md', 'sp ace.md'));
    expect(parsed.added).toEqual(['two\nlines.md']);
    expect(parsed.renamed).toEqual([rename('tab\there.md', 'sp ace.md')]);
  });

  it('treats a copy as an addition of the copy', () => {
    expect(parseNameStatus(z('C075', 'orig.md', 'copy.md')).added).toEqual(['copy.md']);
  });

  it('sorts each list by path', () => {
    const parsed = parseNameStatus(z('A', 'b', 'A', 'a', 'R100', 'z', 'y', 'R100', 'x', 'w'));
    expect(parsed.added).toEqual(['a', 'b']);
    expect(parsed.renamed.map((r) => r.from)).toEqual(['x', 'z']);
  });

  it('returns empty lists for empty output', () => {
    expect(parseNameStatus(Buffer.alloc(0))).toEqual({ added: [], deleted: [], modified: [], renamed: [] });
  });

  it('rejects statuses it does not know and truncated records', () => {
    expect(() => parseNameStatus(z('U', 'conflict.md'))).toThrow(GitError);
    expect(() => parseNameStatus(Buffer.from('A\0', 'utf8'))).toThrow(GitError);
    expect(() => parseNameStatus(z('R100', 'only-from.md'))).toThrow(GitError);
    expect(() => parseNameStatus(z('Rxx', 'a', 'b'))).toThrow(GitError);
  });
});

describe('renameLimitWarning', () => {
  it('recognises both of git\'s messages', () => {
    expect(renameLimitWarning('warning: exhaustive rename detection was skipped due to too many files.\n', 5)).toMatch(
      /diff\.renameLimit=5/,
    );
    expect(renameLimitWarning('warning: inexact rename detection was skipped due to too many files.\n', 5)).toMatch(
      /rename detection was skipped/,
    );
  });

  it('quotes the limit git suggests when it gives one', () => {
    const stderr =
      'warning: exhaustive rename detection was skipped due to too many files.\n' +
      'warning: you may want to set your diff.renameLimit variable to at least 1234 and retry the command.\n';
    expect(renameLimitWarning(stderr, 5)).toMatch(/at least 1234/);
  });

  it('is undefined for unrelated or empty stderr', () => {
    expect(renameLimitWarning('', 5)).toBeUndefined();
    expect(renameLimitWarning('warning: LF will be replaced by CRLF\n', 5)).toBeUndefined();
  });
});
