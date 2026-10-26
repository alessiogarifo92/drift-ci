import { describe, expect, it } from 'vitest';
import { deriveDirectoryRenames, type Rename } from '../src/core/snapshot.ts';

const rename = (from: string, to: string, similarity = 100): Rename => ({ from, to, similarity });
const dirRename = (from: string, to: string): Rename => rename(from, to, 100);

describe('deriveDirectoryRenames', () => {
  it('derives a directory rename when every file under it moved to the same new prefix', () => {
    const renames = [rename('docs/a.md', 'guides/a.md'), rename('docs/b.md', 'guides/b.md', 80)];
    const base = ['README.md', 'docs/a.md', 'docs/b.md'];
    expect(deriveDirectoryRenames(renames, base)).toEqual([dirRename('docs', 'guides')]);
  });

  it('does not derive a rename when only part of the directory moved', () => {
    // docs/b.md is in base but not renamed: it stayed, was deleted or was modified in place.
    const renames = [rename('docs/a.md', 'guides/a.md')];
    const base = ['docs/a.md', 'docs/b.md'];
    expect(deriveDirectoryRenames(renames, base)).toEqual([]);
  });

  it('does not derive a rename when a file moved to a different prefix', () => {
    const renames = [rename('docs/a.md', 'guides/a.md'), rename('docs/b.md', 'manual/b.md')];
    const base = ['docs/a.md', 'docs/b.md'];
    expect(deriveDirectoryRenames(renames, base)).toEqual([]);
  });

  it('does not derive a rename when a file changed its own name while moving', () => {
    const renames = [rename('docs/a.md', 'guides/a.md'), rename('docs/b.md', 'guides/c.md')];
    expect(deriveDirectoryRenames(renames, ['docs/a.md', 'docs/b.md'])).toEqual([]);
  });

  it('reports only the outermost directory when nested directories moved together', () => {
    const renames = [
      rename('src/app/index.ts', 'lib/app/index.ts'),
      rename('src/app/ui/button.ts', 'lib/app/ui/button.ts'),
      rename('src/app/ui/icons/x.svg', 'lib/app/ui/icons/x.svg'),
    ];
    const base = renames.map((r) => r.from);
    expect(deriveDirectoryRenames(renames, base)).toEqual([dirRename('src', 'lib')]);
  });

  it('reports an inner directory that moved somewhere other than its parent', () => {
    const renames = [
      rename('src/app/index.ts', 'lib/app/index.ts'),
      rename('src/app/ui/button.ts', 'widgets/button.ts'),
    ];
    const base = renames.map((r) => r.from);
    expect(deriveDirectoryRenames(renames, base)).toEqual([
      dirRename('src/app/ui', 'widgets'),
    ]);
  });

  it('reports a moved inner directory next to its parent when the parent has other content', () => {
    const renames = [rename('src/ui/a.ts', 'lib/ui/a.ts'), rename('src/ui/b.ts', 'lib/ui/b.ts')];
    const base = [...renames.map((r) => r.from), 'src/main.ts'];
    expect(deriveDirectoryRenames(renames, base)).toEqual([dirRename('src/ui', 'lib/ui')]);
  });

  it('keeps an inner rename when its parent was renamed to a different place', () => {
    // src/ → lib/, except src/ui/ which went to widgets/: both are real, neither implies the other.
    const renames = [
      rename('src/main.ts', 'lib/main.ts'),
      rename('src/ui/a.ts', 'widgets/a.ts'),
      rename('src/ui/b.ts', 'widgets/b.ts'),
    ];
    const base = renames.map((r) => r.from);
    expect(deriveDirectoryRenames(renames, base)).toEqual([dirRename('src/ui', 'widgets')]);
  });

  it('handles a rename that only changes the last path segment of a deep directory', () => {
    const renames = [rename('a/b/c/x.md', 'a/b/d/x.md')];
    expect(deriveDirectoryRenames(renames, ['a/b/c/x.md', 'a/other.md'])).toEqual([
      dirRename('a/b/c', 'a/b/d'),
    ]);
  });

  it('derives a rename into a subdirectory of itself', () => {
    const renames = [rename('docs/a.md', 'docs/old/a.md')];
    expect(deriveDirectoryRenames(renames, ['docs/a.md'])).toEqual([dirRename('docs', 'docs/old')]);
  });

  it('never derives a rename for the repository root', () => {
    // Every file moved under sub/, but "" → "sub" is not a directory rename.
    const renames = [rename('a.md', 'sub/a.md'), rename('b.md', 'sub/b.md')];
    expect(deriveDirectoryRenames(renames, ['a.md', 'b.md'])).toEqual([]);
  });

  it('never derives a rename into the repository root', () => {
    const renames = [rename('docs/a.md', 'a.md')];
    expect(deriveDirectoryRenames(renames, ['docs/a.md'])).toEqual([]);
  });

  it('does not treat a sibling with a shared name prefix as part of the directory', () => {
    const renames = [rename('doc/a.md', 'guide/a.md')];
    expect(deriveDirectoryRenames(renames, ['doc/a.md', 'docs/b.md'])).toEqual([
      dirRename('doc', 'guide'),
    ]);
  });

  it('returns directory renames sorted by source path', () => {
    const renames = [rename('zeta/a.md', 'z2/a.md'), rename('alpha/a.md', 'a2/a.md')];
    expect(deriveDirectoryRenames(renames, ['zeta/a.md', 'alpha/a.md'])).toEqual([
      dirRename('alpha', 'a2'),
      dirRename('zeta', 'z2'),
    ]);
  });

  it('returns nothing for no renames', () => {
    expect(deriveDirectoryRenames([], ['a/b.md'])).toEqual([]);
  });
});
