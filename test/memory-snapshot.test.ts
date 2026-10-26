import { describe, expect, it } from 'vitest';
import { changeSet, memorySnapshot } from './helpers/memory-snapshot.ts';

describe('memorySnapshot', () => {
  const snap = memorySnapshot(
    { 'b.md': 'one\nrun FOO_BAR now\nFOO', 'a/x.txt': 'foo_bar_baz', link: 'a/x.txt' },
    { symlinks: ['link'], submodules: ['vendor/lib'], commit: 'abc' },
  );

  it('lists sorted entries of every kind', async () => {
    expect((await snap.listFiles()).map((e) => [e.path, e.kind, e.mode])).toEqual([
      ['a/x.txt', 'file', '100644'],
      ['b.md', 'file', '100644'],
      ['link', 'symlink', '120000'],
      ['vendor/lib', 'submodule', '160000'],
    ]);
    expect(snap.commit).toBe('abc');
  });

  it('reads files, omitting absent paths and submodules', async () => {
    expect(await snap.readFile('b.md')).toContain('FOO_BAR');
    expect(await snap.readFile('vendor/lib')).toBeUndefined();
    expect([...(await snap.readFiles(['a/x.txt', 'nope', 'vendor/lib'])).keys()]).toEqual(['a/x.txt']);
  });

  it('greps whole words only', async () => {
    expect(await snap.grep('FOO_BAR')).toEqual([{ path: 'b.md', line: 2, text: 'run FOO_BAR now' }]);
    expect(await snap.grep('FOO')).toEqual([{ path: 'b.md', line: 3, text: 'FOO' }]);
    expect(await snap.grep('MISSING')).toEqual([]);
  });
});

describe('changeSet', () => {
  it('defaults every list to empty and renames to similarity 100', () => {
    expect(changeSet()).toEqual({ renamed: [], renamedDirs: [], deleted: [], added: [], modified: [], warnings: [] });
    expect(changeSet({ renamed: [{ from: 'a', to: 'b' }] }).renamed).toEqual([{ from: 'a', to: 'b', similarity: 100 }]);
  });
});
