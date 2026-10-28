import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSnapshot, parseCatFileBatch, parseGrep, parseLsTree } from '../src/git/snapshot.ts';
import { GitError, GitNotFoundError } from '../src/git/errors.ts';
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

describe('RepoSnapshot.listFiles', () => {
  it('lists every file of the commit, sorted by path, with mode and oid', async () => {
    const repo = repoFor('sample');
    const head = await openSnapshot(repo.dir, repo.headSha);
    const entries = await head.listFiles();
    expect(entries.map((e) => e.path)).toEqual(['.gitignore', 'README.md', 'docs/guide.md', 'lib/new.ts']);
    expect(entries.every((e) => e.kind === 'file' && e.mode === '100644')).toBe(true);
    expect(entries[1]?.oid).toBe(repo.git('rev-parse', 'HEAD:README.md'));

    const base = await openSnapshot(repo.dir, repo.baseSha);
    expect((await base.listFiles()).map((e) => e.path)).toEqual(['README.md', 'docs/guide.md', 'src/old.ts']);
  });

  it('is built from the commit, not the working tree', async () => {
    const repo = repoFor('sample');
    const base = await openSnapshot(repo.dir, repo.baseSha);
    // HEAD is checked out; base lists a file the working tree no longer has.
    expect((await base.listFiles()).map((e) => e.path)).toContain('src/old.ts');
  });

  it('returns an empty list for an empty tree', async () => {
    const repo = repoFor('delete-all');
    expect(await (await openSnapshot(repo.dir, repo.headSha)).listFiles()).toEqual([]);
  });

  it('keeps names with spaces, unicode and emoji exactly as committed', async () => {
    const repo = repoFor('unicode-names');
    const paths = (await (await openSnapshot(repo.dir, repo.headSha)).listFiles()).map((e) => e.path);
    expect(paths).toEqual([
      'emoji 🚀/old notes.md',
      'my docs/Guía nueva.md',
      'plain/mentions.md',
      '日本語/新しい.md',
    ]);
  });

  it('reports a gitlink as a submodule and does not descend into it', async () => {
    const repo = repoFor('submodule');
    const sha = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'vendor/lib' });
    const entries = await (await openSnapshot(repo.dir, sha)).listFiles();
    expect(entries.map((e) => e.path)).toEqual(['.gitmodules', 'README.md', 'vendor/lib']);
    expect(entries.find((e) => e.path === 'vendor/lib')).toEqual({
      path: 'vendor/lib',
      kind: 'submodule',
      mode: '160000',
      oid: repo.headSha,
    });
  });

  it('reports a symlink as a symlink', async () => {
    const repo = repoFor('submodule');
    const sha = commitWithIndexEntry(repo, {
      mode: '120000',
      oid: repo.git('rev-parse', 'HEAD:README.md'),
      path: 'link',
    });
    const entry = (await (await openSnapshot(repo.dir, sha)).listFiles()).find((e) => e.path === 'link');
    expect(entry).toMatchObject({ kind: 'symlink', mode: '120000' });
  });

  it('runs git once and serves later calls from the cache', async () => {
    const repo = repoFor('sample');
    const snapshot = await openSnapshot(repo.dir, repo.headSha);
    const first = await snapshot.listFiles();
    // A second call after the repository is gone can only succeed from the cache.
    repo.cleanup();
    expect(await snapshot.listFiles()).toBe(first);
  });

  it('shares one listing between concurrent calls', async () => {
    const repo = repoFor('sample');
    const snapshot = await openSnapshot(repo.dir, repo.headSha);
    const [a, b] = await Promise.all([snapshot.listFiles(), snapshot.listFiles()]);
    expect(a).toBe(b);
  });

  it('surfaces a git failure as GitError', async () => {
    const repo = repoFor('sample');
    const snapshot = await openSnapshot(repo.dir, repo.headSha);
    repo.cleanup();
    await expect(snapshot.listFiles()).rejects.toMatchObject({ name: 'GitError' });
    // A failure is not cached: the next call asks git again.
    await expect(snapshot.listFiles()).rejects.toMatchObject({ name: 'GitError' });
  });
});

describe('RepoSnapshot.readFile', () => {
  it('reads a file as UTF-8 from the commit', async () => {
    const repo = repoFor('sample');
    const head = await openSnapshot(repo.dir, repo.headSha);
    const base = await openSnapshot(repo.dir, repo.baseSha);
    expect(await head.readFile('.gitignore')).toBe('build/\n');
    expect(await base.readFile('.gitignore')).toBeUndefined();
    expect(await base.readFile('src/old.ts')).toBe(await head.readFile('lib/new.ts'));
  });

  it('returns undefined for a missing path and for a directory', async () => {
    const repo = repoFor('sample');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect(await head.readFile('nope.md')).toBeUndefined();
    expect(await head.readFile('docs')).toBeUndefined();
    expect(await head.readFile('docs/')).toBeUndefined();
  });

  it('returns undefined for a submodule gitlink', async () => {
    const repo = repoFor('submodule');
    const sha = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'vendor/lib' });
    const snapshot = await openSnapshot(repo.dir, sha);
    expect(await snapshot.readFile('vendor/lib')).toBeUndefined();
    expect(await snapshot.readFile('README.md')).toContain('vendor/lib');
  });

  it('keeps CRLF and unicode content byte-exact', async () => {
    const crlf = await openSnapshot(repoFor('crlf').dir, 'HEAD');
    expect(await crlf.readFile('NOTES.md')).toBe('line one\r\nsee `src/b.ts`\r\n');
    const unicode = await openSnapshot(repoFor('unicode-names').dir, 'HEAD');
    expect(await unicode.readFile('plain/mentions.md')).toBe('Ver `my docs/Guía rápida.md` y la palabra café.\n');
    expect(await unicode.readFile('日本語/新しい.md')).toContain('nihongo line 1\n');
  });

  it('reads an empty file as an empty string', async () => {
    const repo = repoFor('sample');
    const emptyBlob = repo.git('hash-object', '-w', '-t', 'blob', '/dev/null');
    const sha = commitWithIndexEntry(repo, { mode: '100644', oid: emptyBlob, path: 'empty.txt' });
    expect(await (await openSnapshot(repo.dir, sha)).readFile('empty.txt')).toBe('');
  });

  it('reads the target of a symlink', async () => {
    const repo = repoFor('submodule');
    const sha = commitWithIndexEntry(repo, {
      mode: '120000',
      oid: repo.git('rev-parse', 'HEAD:.gitmodules'),
      path: 'link',
    });
    const snapshot = await openSnapshot(repo.dir, sha);
    expect(await snapshot.readFile('link')).toContain('[submodule');
  });
});

describe('RepoSnapshot.readFiles', () => {
  it('reads several files in one batch and omits absent paths', async () => {
    const repo = repoFor('sample');
    const head = await openSnapshot(repo.dir, repo.headSha);
    const files = await head.readFiles(['README.md', 'missing.md', 'docs/guide.md', 'docs', '.gitignore']);
    expect([...files.keys()].sort()).toEqual(['.gitignore', 'README.md', 'docs/guide.md']);
    expect(files.get('.gitignore')).toBe('build/\n');
    expect(files.get('README.md')).toBe(await head.readFile('README.md'));
  });

  it('returns an empty map for no paths or no match', async () => {
    const repo = repoFor('sample');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect((await head.readFiles([])).size).toBe(0);
    expect((await head.readFiles(['nope'])).size).toBe(0);
  });

  it('gives every path its content when two paths share one blob', async () => {
    const repo = repoFor('sample');
    const readme = repo.git('rev-parse', 'HEAD:README.md');
    const sha = commitWithIndexEntry(repo, { mode: '100644', oid: readme, path: 'COPY.md' });
    const files = await (await openSnapshot(repo.dir, sha)).readFiles(['README.md', 'COPY.md', 'README.md']);
    expect(files.size).toBe(2);
    expect(files.get('COPY.md')).toBe(files.get('README.md'));
  });

  it('handles many files in a single call', async () => {
    const repo = repoFor('rename-limit');
    const head = await openSnapshot(repo.dir, repo.headSha);
    const paths = (await head.listFiles()).map((e) => e.path);
    const files = await head.readFiles(paths);
    expect(files.size).toBe(paths.length);
    expect(files.get('pkg/n1.txt')).toContain('file1 line 1\n');
  });

  it('reads files far larger than a pipe buffer completely', async () => {
    const repo = repoFor('sample');
    const text = 'x'.repeat(99) + '\n';
    writeFileSync(join(repo.dir, 'big.txt'), text.repeat(5000));
    const oid = repo.git('hash-object', '-w', 'big.txt');
    const sha = commitWithIndexEntry(repo, { mode: '100644', oid, path: 'big.txt' });
    const snapshot = await openSnapshot(repo.dir, sha);
    const files = await snapshot.readFiles(['big.txt', 'README.md']);
    expect(files.get('big.txt')).toBe(text.repeat(5000));
    expect(files.get('README.md')).toBeDefined();
  });
});

describe('RepoSnapshot.grep', () => {
  it('finds whole words with their path and 1-indexed line', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    const hits = await head.grep('FOO_BAR');
    expect(hits).toEqual([
      { path: 'README.md', line: 2, text: 'Set FOO_BAR=1 before running.' },
      { path: 'README.md', line: 5, text: 'A line with a TAB\tand FOO_BAR again.' },
      { path: 'crlf.md', line: 1, text: 'FOO_BAR on a crlf line\r' },
      { path: 'docs/guía.md', line: 1, text: 'uses FOO_BAR here' },
      { path: 'src/code.ts', line: 1, text: 'export const FOO_BAR = process.env.FOO_BAR;' },
    ]);
  });

  it('does not match inside longer words and is case sensitive', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect((await head.grep('FOO_BARISTA')).map((h) => h.line)).toEqual([3]);
    expect((await head.grep('FOO')).length).toBe(0);
    expect((await head.grep('foo')).map((h) => h.line)).toEqual([4]);
  });

  it('ignores case with `ignoreCase`, still whole words only', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect((await head.grep('FOO', { ignoreCase: true })).map((h) => h.line)).toEqual([4]);
    expect((await head.grep('foo_bar', { ignoreCase: true })).length).toBe((await head.grep('FOO_BAR')).length);
    expect((await head.grep('foo', { ignoreCase: false })).map((h) => h.line)).toEqual([4]);
  });

  it('treats the word as a fixed string, not a regular expression', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect(await head.grep('FOO.BAR')).toEqual([]);
    expect(await head.grep('.*')).toEqual([]);
  });

  it('searches the commit, not the working tree', async () => {
    const repo = repoFor('grep');
    const base = await openSnapshot(repo.dir, repo.baseSha);
    // HEAD is checked out and contains FOO_BAR; base does not.
    expect(await base.grep('FOO_BAR')).toEqual([]);
    expect((await base.grep('build')).map((h) => h.path)).toEqual(['README.md']);
  });

  it('returns [] when nothing matches', async () => {
    const repo = repoFor('grep');
    expect(await (await openSnapshot(repo.dir, repo.headSha)).grep('no_such_word')).toEqual([]);
  });

  it('skips binary files', async () => {
    const repo = repoFor('grep');
    const paths = (await (await openSnapshot(repo.dir, repo.headSha)).grep('FOO_BAR')).map((h) => h.path);
    expect(paths).not.toContain('binary.bin');
  });

  it('narrows the search with pathspecs', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect((await head.grep('FOO_BAR', { pathspecs: ['docs'] })).map((h) => h.path)).toEqual(['docs/guía.md']);
    expect((await head.grep('FOO_BAR', { pathspecs: ['*.md'] })).map((h) => h.path)).toEqual([
      'README.md',
      'README.md',
      'crlf.md',
      'docs/guía.md',
    ]);
    expect(await head.grep('FOO_BAR', { pathspecs: ['nowhere'] })).toEqual([]);
  });

  it('searches everything when pathspecs is empty', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect((await head.grep('FOO_BAR', { pathspecs: [] })).length).toBe(5);
  });

  it('finds words in files with spaces and unicode in their path', async () => {
    const repo = repoFor('unicode-names');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect((await head.grep('nihongo')).map((h) => h.path)).toContain('日本語/新しい.md');
    expect((await head.grep('café')).map((h) => h.path)).toEqual(['plain/mentions.md']);
    expect((await head.grep('rocket', { pathspecs: ['emoji 🚀'] })).length).toBe(12);
  });

  it('does not search into a submodule', async () => {
    const repo = repoFor('submodule');
    const sha = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'vendor/lib' });
    const hits = await (await openSnapshot(repo.dir, sha)).grep('bar');
    expect(hits.map((h) => h.path)).toEqual(['README.md']);
  });

  it('accepts a word that starts with a dash', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    expect(await head.grep('--no-such-flag')).toEqual([]);
  });

  it('rejects an empty word and a multi-line word instead of matching everything', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    await expect(head.grep('')).rejects.toBeInstanceOf(RangeError);
    await expect(head.grep('a\nb')).rejects.toBeInstanceOf(RangeError);
  });

  it('surfaces git failures as typed errors', async () => {
    const repo = repoFor('grep');
    const head = await openSnapshot(repo.dir, repo.headSha);
    await expect(head.grep('FOO_BAR', { pathspecs: [':(bogus)x'] })).rejects.toMatchObject({
      name: 'GitError',
    });
    repo.cleanup();
    await expect(head.grep('FOO_BAR')).rejects.toMatchObject({ name: 'GitError' });
  });
});

describe('RepoSnapshot on a shallow clone', () => {
  it('lists, reads and greps the commits a fetch-depth: 2 checkout has', async () => {
    const repo = repoFor('grep');
    const { baseSha, headSha, rootSha } = withOlderHistory(repo);
    const clone = shallowClone(repo, 2);
    cleanups.push(clone.cleanup);

    const head = await openSnapshot(clone.dir, headSha);
    const base = await openSnapshot(clone.dir, 'HEAD^');
    expect(base.commit).toBe(baseSha);
    expect((await head.listFiles()).map((e) => e.path)).toContain('docs/guía.md');
    expect(await head.readFile('src/code.ts')).toContain('FOO_BAR');
    expect((await head.grep('FOO_BAR')).length).toBe(5);
    expect(await base.grep('FOO_BAR')).toEqual([]);

    await expect(openSnapshot(clone.dir, rootSha)).rejects.toMatchObject({ name: 'UnknownRevisionError' });
  });
});

describe('openSnapshot', () => {
  it('exposes the full SHA of the commit', async () => {
    const repo = repoFor('sample');
    const snapshot = await openSnapshot(repo.dir, 'HEAD');
    expect(snapshot.commit).toBe(repo.headSha);
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('passes the git binary through to every command', async () => {
    const repo = repoFor('sample');
    await expect(openSnapshot(repo.dir, 'HEAD', { gitBinary: '/nonexistent/git' })).rejects.toBeInstanceOf(
      GitNotFoundError,
    );
  });
});

describe('output parsers', () => {
  const oid = 'a'.repeat(40);
  const sha = 'b'.repeat(40);

  it('parseLsTree keeps tabs and newlines inside paths and sorts by path', () => {
    const output = Buffer.from(`100644 blob ${oid}\tb\ttab\x00100755 blob ${oid}\ta\nnl\x00`, 'utf8');
    expect(parseLsTree(output)).toEqual([
      { path: 'a\nnl', kind: 'file', mode: '100755', oid },
      { path: 'b\ttab', kind: 'file', mode: '100644', oid },
    ]);
  });

  it('parseLsTree rejects a malformed record', () => {
    expect(() => parseLsTree(Buffer.from('not a tree record\x00'))).toThrow(GitError);
  });

  it('parseCatFileBatch skips missing objects and keeps content that contains newlines', () => {
    const output = Buffer.from(`${oid} blob 7\nline\n\nx\n${sha} missing\n`, 'utf8');
    expect(parseCatFileBatch(output)).toEqual(new Map([[oid, 'line\n\nx']]));
  });

  it('parseCatFileBatch counts size in bytes, not characters', () => {
    const output = Buffer.from(`${oid} blob 5\ncafé\n`, 'utf8');
    expect(parseCatFileBatch(output).get(oid)).toBe('café');
  });

  it('parseCatFileBatch rejects truncated or malformed output', () => {
    expect(() => parseCatFileBatch(Buffer.from(`${oid} blob 7`))).toThrow(GitError);
    expect(() => parseCatFileBatch(Buffer.from(`${oid} blob 70\nshort\n`))).toThrow(GitError);
    expect(() => parseCatFileBatch(Buffer.from(`${oid} blob nope\n`))).toThrow(GitError);
  });

  it('parseGrep reads path, line and text, and tolerates a missing final newline', () => {
    const output = Buffer.from(`${sha}:a b.md\u00003\u0000hello\n${sha}:c.md\u000012\u0000last`, 'utf8');
    expect(parseGrep(output, sha)).toEqual([
      { path: 'a b.md', line: 3, text: 'hello' },
      { path: 'c.md', line: 12, text: 'last' },
    ]);
  });

  it('parseGrep rejects output that is not for the expected commit', () => {
    expect(() => parseGrep(Buffer.from('other:a.md\u00001\u0000x\n'), sha)).toThrow(GitError);
    expect(() => parseGrep(Buffer.from(`${sha}:a.md\u0000x\u0000y\n`), sha)).toThrow(GitError);
  });
});
