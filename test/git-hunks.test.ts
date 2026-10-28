import { afterEach, describe, expect, it } from 'vitest';
import { GitError, UnknownRevisionError } from '../src/git/errors.ts';
import { computeHunks, parseUnifiedDiff } from '../src/git/hunks.ts';
import { createFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.ts';

const diff = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('parseUnifiedDiff', () => {
  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n')).toEqual([]);
  });

  it('reads removed and added lines of one hunk', () => {
    const text = diff(
      'diff --git a/src/a.js b/src/a.js',
      'index 111..222 100644',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -3,2 +3,1 @@ function x() {',
      '-const a = process.env.OLD;',
      '-const b = 2;',
      '+const a = process.env.NEW;',
    );
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'src/a.js', removed: ['const a = process.env.OLD;', 'const b = 2;'], added: ['const a = process.env.NEW;'] },
    ]);
  });

  it('emits one hunk per @@ block and one group per file', () => {
    const text = diff(
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1 +1 @@',
      '-one',
      '+uno',
      '@@ -10,0 +11,2 @@',
      '+x',
      '+y',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -5 +4,0 @@',
      '-gone',
    );
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'a.js', removed: ['one'], added: ['uno'] },
      { path: 'a.js', removed: [], added: ['x', 'y'] },
      { path: 'b.js', removed: ['gone'], added: [] },
    ]);
  });

  it('uses the base path for a deleted file', () => {
    const text = diff(
      'diff --git a/.env.example b/.env.example',
      'deleted file mode 100644',
      'index 111..000',
      '--- a/.env.example',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-API_KEY=',
      '-DB_URL=',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: '.env.example', removed: ['API_KEY=', 'DB_URL='], added: [] }]);
  });

  it('uses the head path for an added file', () => {
    const text = diff(
      'diff --git a/new.js b/new.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.js',
      '@@ -0,0 +1 @@',
      '+hello',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'new.js', removed: [], added: ['hello'] }]);
  });

  it('uses the head path for a rename with edits and ignores a pure rename', () => {
    const text = diff(
      'diff --git a/old.js b/new.js',
      'similarity index 90%',
      'rename from old.js',
      'rename to new.js',
      '--- a/old.js',
      '+++ b/new.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/p.js b/q.js',
      'similarity index 100%',
      'rename from p.js',
      'rename to q.js',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'new.js', removed: ['a'], added: ['b'] }]);
  });

  it('skips binary files and mode-only changes', () => {
    const text = diff(
      'diff --git a/img.png b/img.png',
      'index 111..222 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'a.js', removed: ['a'], added: ['b'] }]);
  });

  it('ignores the no-newline marker', () => {
    const text = diff(
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'a.txt', removed: ['old'], added: ['new'] }]);
  });

  it('ignores the no-newline marker after the last line of a hunk', () => {
    const text = diff(
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    );
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'a.txt', removed: ['old'], added: ['new'] },
      { path: 'b.txt', removed: ['p'], added: ['q'] },
    ]);
  });

  it('keeps the backslash of an unknown escape in a quoted path', () => {
    const text = diff('diff --git "a/x\\qy" "b/x\\qy"', '--- "a/x\\qy"', '+++ "b/x\\qy"', '@@ -1 +1 @@', '-a', '+b');
    expect(parseUnifiedDiff(text).map((h) => h.path)).toEqual(['x\\qy']);
  });

  it('keeps a removed or added line that itself starts with -- or ++', () => {
    const text = diff(
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,2 +1,2 @@',
      '--- not a header',
      '-- yaml-ish',
      '+++ not a header either',
      '++ plus',
      'diff --git a/b.md b/b.md',
      '--- a/b.md',
      '+++ b/b.md',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    );
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'a.md', removed: ['-- not a header', '- yaml-ish'], added: ['++ not a header either', '+ plus'] },
      { path: 'b.md', removed: ['x'], added: ['y'] },
    ]);
  });

  it('reads a removed line that looks like a diff header inside a hunk', () => {
    const text = diff(
      'diff --git a/a.patch b/a.patch',
      '--- a/a.patch',
      '+++ b/a.patch',
      '@@ -1,2 +1,0 @@',
      '-diff --git a/x b/x',
      '-@@ -1 +1 @@',
    );
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'a.patch', removed: ['diff --git a/x b/x', '@@ -1 +1 @@'], added: [] },
    ]);
  });

  it('strips the tab git appends to paths with spaces', () => {
    const text = diff(
      'diff --git a/my file.txt b/my file.txt',
      '--- a/my file.txt\t',
      '+++ b/my file.txt\t',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'my file.txt', removed: ['a'], added: ['b'] }]);
  });

  it('unquotes C-escaped paths, octal UTF-8 bytes included', () => {
    const text = diff(
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      '--- "a/tab\\there.txt"',
      '+++ "b/tab\\there.txt"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/caf\\303\\251 \\"q\\".txt" "b/caf\\303\\251 \\"q\\".txt"',
      '--- "a/caf\\303\\251 \\"q\\".txt"',
      '+++ "b/caf\\303\\251 \\"q\\".txt"',
      '@@ -1 +1 @@',
      '-c',
      '+d',
      'diff --git "a/back\\\\slash.txt" "b/back\\\\slash.txt"',
      '--- "a/back\\\\slash.txt"',
      '+++ "b/back\\\\slash.txt"',
      '@@ -1 +1 @@',
      '-e',
      '+f',
    );
    expect(parseUnifiedDiff(text).map((h) => h.path)).toEqual(['tab\there.txt', 'café "q".txt', 'back\\slash.txt']);
  });

  it('uses the base path from a quoted header when the file is deleted', () => {
    const text = diff(
      'diff --git "a/x y.txt" "b/x y.txt"',
      'deleted file mode 100644',
      '--- "a/x y.txt"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    );
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'x y.txt', removed: ['gone'], added: [] }]);
  });

  it('defaults the line counts of a hunk header to 1', () => {
    const text = diff('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -4 +4 @@', '-x', '+y', '@@ -9 +9 @@', '-p', '+q');
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'a', removed: ['x'], added: ['y'] },
      { path: 'a', removed: ['p'], added: ['q'] },
    ]);
  });

  it('keeps CRLF line content untouched and tolerates a missing final newline', () => {
    const text = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\r\n+y';
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'a', removed: ['x\r'], added: ['y'] }]);
  });
});

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

describe('computeHunks', () => {
  it('computes hunks between two commits of a repository', async () => {
    const repo = createFixtureRepo('hunks-sample');
    repos.push(repo);
    const hunks = await computeHunks(repo.dir, repo.baseSha, repo.headSha);
    expect(hunks).toEqual([
      { path: '.env.example', removed: ['API_KEY='], added: [] },
      { path: 'README.md', removed: ['Set `OLD_NAME`.'], added: ['Set `NEW_NAME`.'] },
      { path: 'added.js', removed: [], added: ['fresh'] },
      { path: 'gone.js', removed: ['process.env.GONE;'], added: [] },
      { path: 'moved/new name.js', removed: ['old'], added: ['new'] },
    ]);
  });

  it('resolves refs, not only SHAs', async () => {
    const repo = createFixtureRepo('hunks-sample');
    repos.push(repo);
    expect(await computeHunks(repo.dir, 'HEAD^', 'HEAD')).toEqual(await computeHunks(repo.dir, repo.baseSha, repo.headSha));
  });

  it('finds nothing between identical commits', async () => {
    const repo = createFixtureRepo('hunks-sample');
    repos.push(repo);
    expect(await computeHunks(repo.dir, 'HEAD', 'HEAD')).toEqual([]);
  });

  it('rejects with UnknownRevisionError on an unknown revision', async () => {
    const repo = createFixtureRepo('hunks-sample');
    repos.push(repo);
    await expect(computeHunks(repo.dir, 'no-such-ref', 'HEAD')).rejects.toBeInstanceOf(UnknownRevisionError);
    await expect(computeHunks(repo.dir, 'HEAD', 'no-such-ref')).rejects.toBeInstanceOf(UnknownRevisionError);
  });

  it('rejects with GitError when the directory does not exist', async () => {
    await expect(computeHunks('/nonexistent-drift-ci-dir', 'a', 'b')).rejects.toBeInstanceOf(GitError);
  });
});
