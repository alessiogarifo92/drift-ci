import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/check.ts';
import type { Finding } from '../src/core/finding.ts';
import type { Reference } from '../src/core/reference.ts';
import { pathRule } from '../src/core/rules/path.ts';
import { changeSet, memorySnapshot, type MemorySnapshotOptions } from './helpers/memory-snapshot.ts';

type Files = Record<string, string>;
type Changes = Parameters<typeof changeSet>[0];

interface Scenario {
  base: Files;
  head: Files;
  changes?: Changes;
  baseOptions?: MemorySnapshotOptions;
  headOptions?: MemorySnapshotOptions;
  repo?: { owner: string; name: string };
}

async function findings(s: Scenario): Promise<Finding[]> {
  const result = await runCheck(
    memorySnapshot(s.base, s.baseOptions),
    memorySnapshot(s.head, s.headOptions),
    changeSet(s.changes),
    { rules: [pathRule()], ...(s.repo ? { repo: s.repo } : {}) },
  );
  return result.findings;
}

/** `fact → suggestion` (or `fact → none`), the essence of what was flagged. */
async function brief(s: Scenario): Promise<string[]> {
  return (await findings(s)).map((f) => `${f.fact} -> ${f.suggestion ?? 'none'}`);
}

const F = 'x';

describe('pathRule: what is drift', () => {
  it('flags a renamed file, with the new location as suggestion', async () => {
    const [finding] = await findings({
      base: { 'README.md': 'See `src/old.ts`.', 'src/old.ts': F },
      head: { 'README.md': 'See `src/old.ts`.', 'lib/new.ts': F },
      changes: { renamed: [{ from: 'src/old.ts', to: 'lib/new.ts' }] },
    });
    expect(finding).toMatchObject({
      ruleId: 'path',
      kind: 'path',
      fact: 'src/old.ts',
      file: 'README.md',
      line: 1,
      col: 6,
      message: '`src/old.ts` was renamed to `lib/new.ts` in this change',
      suggestion: 'lib/new.ts',
    });
  });

  it('flags a deleted file without a suggestion', async () => {
    const [finding] = await findings({
      base: { 'README.md': 'See `src/old.ts`.', 'src/old.ts': F },
      head: { 'README.md': 'See `src/old.ts`.' },
      changes: { deleted: ['src/old.ts'] },
    });
    expect(finding?.message).toBe('`src/old.ts` was removed in this change');
    expect(finding && 'suggestion' in finding).toBe(false);
  });

  it('does not flag a reference that was already broken in base', async () => {
    expect(await brief({ base: { 'README.md': '`src/never.ts`' }, head: { 'README.md': '`src/never.ts`' } })).toEqual([]);
  });

  it('does not flag a doc already updated in the change', async () => {
    expect(
      await brief({
        base: { 'README.md': '`src/old.ts`', 'src/old.ts': F },
        head: { 'README.md': '`lib/new.ts`', 'lib/new.ts': F },
        changes: { renamed: [{ from: 'src/old.ts', to: 'lib/new.ts' }] },
      }),
    ).toEqual([]);
  });

  it('does not flag a path that still resolves', async () => {
    expect(
      await brief({
        base: { 'README.md': '`src/a.ts`', 'src/a.ts': F },
        head: { 'README.md': '`src/a.ts`', 'src/a.ts': 'changed' },
        changes: { modified: ['src/a.ts'] },
      }),
    ).toEqual([]);
  });

  it('a path that exists on another candidate in head is not drift', async () => {
    // Doc-relative candidate `docs/x.ts` is gone, but the repo-root `x.ts` exists in head.
    expect(
      await brief({
        base: { 'docs/a.md': '`x.ts`', 'docs/x.ts': F, 'x.ts': F },
        head: { 'docs/a.md': '`x.ts`', 'x.ts': F },
        changes: { deleted: ['docs/x.ts'] },
      }),
    ).toEqual([]);
  });

  it('flags a directory reference when nothing is left under it, keeping the trailing slash', async () => {
    expect(
      await brief({
        base: { 'README.md': '[d](docs/old/)', 'docs/old/a.md': F, 'docs/old/b.md': F },
        head: { 'README.md': '[d](docs/old/)' },
        changes: { deleted: ['docs/old/a.md', 'docs/old/b.md'] },
      }),
    ).toEqual(['docs/old -> none']);
  });

  it('does not flag a directory that keeps a file', async () => {
    expect(
      await brief({
        base: { 'README.md': '[d](docs/old/)', 'docs/old/a.md': F, 'docs/old/b.md': F },
        head: { 'README.md': '[d](docs/old/)', 'docs/old/b.md': F },
        changes: { deleted: ['docs/old/a.md'] },
      }),
    ).toEqual([]);
  });

  it('treats symlinks as existing paths', async () => {
    expect(
      await brief({
        base: { 'README.md': '`bin/tool`', 'bin/tool': 'target' },
        head: { 'README.md': '`bin/tool`', 'bin/tool': 'target' },
        baseOptions: { symlinks: ['bin/tool'] },
        headOptions: { symlinks: ['bin/tool'] },
      }),
    ).toEqual([]);
  });

  it('flags a link whose fragment is ignored, e.g. a#anchor, and keeps the fragment in the suggestion', async () => {
    expect(
      await brief({
        base: { 'README.md': '[g](docs/guide.md#install)', 'docs/guide.md': F },
        head: { 'README.md': '[g](docs/guide.md#install)', 'docs/handbook.md': F },
        changes: { renamed: [{ from: 'docs/guide.md', to: 'docs/handbook.md' }] },
      }),
    ).toEqual(['docs/guide.md -> docs/handbook.md#install']);
  });

  it('flags a case-only rename', async () => {
    const result = await findings({
      base: { 'README.md': '[a](Docs/A.md)', 'Docs/A.md': F },
      head: { 'README.md': '[a](Docs/A.md)', 'docs/a.md': F },
      changes: { renamed: [{ from: 'Docs/A.md', to: 'docs/a.md' }] },
    });
    expect(result.map((f) => `${f.fact} -> ${f.suggestion}`)).toEqual(['Docs/A.md -> docs/a.md']);
  });

  it('reports each occurrence separately', async () => {
    const result = await findings({
      base: { 'README.md': '`src/old.ts`\n\nAgain `src/old.ts`.', 'src/old.ts': F },
      head: { 'README.md': '`src/old.ts`\n\nAgain `src/old.ts`.' },
    });
    expect(result.map((f) => `${f.line}:${f.col}`)).toEqual(['1:2', '3:8']);
  });
});

describe('pathRule: resolution order', () => {
  it('resolves doc-relative first', async () => {
    expect(
      await brief({
        base: { 'docs/a.md': '`x.ts`', 'docs/x.ts': F, 'x.ts': F },
        head: { 'docs/a.md': '`x.ts`' },
        changes: { deleted: ['docs/x.ts', 'x.ts'] },
      }),
    ).toEqual(['docs/x.ts -> none']);
  });

  it('falls back to the nearest package root, then the repo root', async () => {
    const base = {
      'package.json': '{}',
      'packages/a/package.json': '{}',
      'packages/a/docs/guide.md': '`src/index.ts`',
      'packages/a/src/index.ts': F,
      'src/index.ts': F,
    };
    const head = {
      'package.json': '{}',
      'packages/a/package.json': '{}',
      'packages/a/docs/guide.md': '`src/index.ts`',
      'src/index.ts': F,
    };
    // The package-root candidate is gone but the repo-root one remains in head: not drift.
    expect(await brief({ base, head, changes: { deleted: ['packages/a/src/index.ts'] } })).toEqual([]);
    // Both gone: the matched base candidate is the package-root one.
    const headWithout = Object.fromEntries(Object.entries(head).filter(([path]) => path !== 'src/index.ts'));
    expect(await brief({ base, head: headWithout })).toEqual(['packages/a/src/index.ts -> none']);
  });

  it('resolves a monorepo package README against its package', async () => {
    expect(
      await brief({
        base: { 'packages/a/package.json': '{}', 'packages/a/README.md': '`src/index.ts`', 'packages/a/src/index.ts': F },
        head: { 'packages/a/package.json': '{}', 'packages/a/README.md': '`src/index.ts`', 'packages/a/src/main.ts': F },
        changes: { renamed: [{ from: 'packages/a/src/index.ts', to: 'packages/a/src/main.ts' }] },
      }),
    ).toEqual(['packages/a/src/index.ts -> src/main.ts']);
  });

  it('uses the nearest package.json, not an outer one', async () => {
    const result = await brief({
      base: {
        'packages/a/package.json': '{}',
        'packages/a/inner/package.json': '{}',
        'packages/a/inner/README.md': '`lib/x.ts`',
        'packages/a/lib/x.ts': F,
        'packages/a/inner/lib/x.ts': F,
      },
      head: {
        'packages/a/package.json': '{}',
        'packages/a/inner/package.json': '{}',
        'packages/a/inner/README.md': '`lib/x.ts`',
        'packages/a/lib/x.ts': F,
      },
      changes: { deleted: ['packages/a/inner/lib/x.ts'] },
    });
    // Doc-relative (packages/a/inner/lib/x.ts) matched first and is gone;
    // the outer package's lib/x.ts is not a candidate.
    expect(result).toEqual(['packages/a/inner/lib/x.ts -> none']);
  });

  it('looks for the package root in each side own inventory', async () => {
    // Base: package.json at packages/a, so `src/i.ts` resolves to packages/a/src/i.ts.
    // Head: that package.json is gone and so is the file.
    expect(
      await brief({
        base: { 'packages/a/package.json': '{}', 'packages/a/docs/g.md': '`src/i.ts`', 'packages/a/src/i.ts': F },
        head: { 'packages/a/docs/g.md': '`src/i.ts`' },
      }),
    ).toEqual(['packages/a/src/i.ts -> none']);
  });

  it('resolves a root-anchored path against the repo root only', async () => {
    expect(
      await brief({
        base: { 'docs/a.md': '[x](/src/old.ts)', 'src/old.ts': F },
        head: { 'docs/a.md': '[x](/src/old.ts)', 'lib/new.ts': F },
        changes: { renamed: [{ from: 'src/old.ts', to: 'lib/new.ts' }] },
      }),
    ).toEqual(['src/old.ts -> /lib/new.ts']);
    // `docs/src/old.ts` is not a candidate for a rooted link, so a pre-existing broken one stays quiet.
    expect(
      await brief({
        base: { 'docs/a.md': '[x](/src/old.ts)', 'docs/src/old.ts': F },
        head: { 'docs/a.md': '[x](/src/old.ts)' },
      }),
    ).toEqual([]);
  });

  it('resolves ../ against the doc directory', async () => {
    expect(
      await brief({
        base: { 'docs/a.md': '[x](../src/old.ts)', 'src/old.ts': F },
        head: { 'docs/a.md': '[x](../src/old.ts)', 'lib/new.ts': F },
        changes: { renamed: [{ from: 'src/old.ts', to: 'lib/new.ts' }] },
      }),
    ).toEqual(['src/old.ts -> ../lib/new.ts']);
  });

  it('drops candidates that escape the repository', async () => {
    expect(
      await brief({
        base: { 'README.md': '[x](../outside.md)', 'outside.md': F },
        head: { 'README.md': '[x](../outside.md)' },
      }),
    ).toEqual([]);
    expect(
      await brief({
        base: { 'docs/a.md': '[x](../../outside.md)', 'outside.md': F },
        head: { 'docs/a.md': '[x](../../outside.md)' },
      }),
    ).toEqual([]);
  });

  const ref = (normalized: string): Reference => ({
    kind: 'path', normalized, file: 'README.md', line: 1, col: 1, source: 'link', contextLine: normalized, shadow: false,
  });

  it('refuses to check before prepare', () => {
    expect(() => pathRule().check(ref('a.md'), { path: 'README.md' })).toThrow(/prepare\(\) must run before check\(\)/);
  });

  it('never flags the repository root itself', async () => {
    const rule = pathRule();
    const files = memorySnapshot({ 'README.md': F });
    await rule.prepare({
      base: files, head: files, changes: changeSet(),
      baseFiles: await files.listFiles(), headFiles: await files.listFiles(), hunks: [], warn: () => {},
    });
    expect(rule.kinds).toEqual(['path']);
    expect(rule.id).toBe('path');
    for (const normalized of ['', '.', '/', '..']) {
      expect(rule.check(ref(normalized), { path: 'README.md' })).toBeUndefined();
    }
  });
});

describe('pathRule: suppression', () => {
  const gone = (path: string, extra: Partial<Scenario> = {}): Scenario => ({
    base: { 'README.md': `\`${path}\``, [path]: F },
    head: { 'README.md': `\`${path}\`` },
    ...extra,
  });

  it.each(['dist/cli.js', 'build/out.js', 'out/index.html', '.next/server.js', 'coverage/lcov.info', 'packages/a/dist/x.js'])(
    'suppresses a removed path under a common build dir: %s',
    async (path) => {
      expect(await brief(gone(path))).toEqual([]);
    },
  );

  it('does not treat a similarly named directory as a build dir', async () => {
    expect(await brief(gone('distribution/a.js'))).toEqual(['distribution/a.js -> none']);
    expect(await brief(gone('src/rebuild/a.js'))).toEqual(['src/rebuild/a.js -> none']);
  });

  it('suppresses a build directory reference itself', async () => {
    expect(
      await brief({
        base: { 'README.md': '[d](dist/)', 'dist/a.js': F },
        head: { 'README.md': '[d](dist/)' },
      }),
    ).toEqual([]);
  });

  it('suppresses removed paths that the head .gitignore ignores', async () => {
    const scenario = (pattern: string, path: string): Scenario =>
      gone(path, { head: { 'README.md': `\`${path}\``, '.gitignore': `${pattern}\n` } });
    expect(await brief(scenario('*.log', 'logs/app.log'))).toEqual([]);
    expect(await brief(scenario('generated/', 'generated/api.ts'))).toEqual([]);
    expect(await brief(scenario('/secret.env', 'secret.env'))).toEqual([]);
    expect(await brief(scenario('*.log', 'logs/app.txt'))).toEqual(['logs/app.txt -> none']);
  });

  it('suppresses an ignored directory reference', async () => {
    expect(
      await brief({
        base: { 'README.md': '[d](generated)', 'generated/a.ts': F },
        head: { 'README.md': '[d](generated)', '.gitignore': 'generated/\n' },
      }),
    ).toEqual([]);
  });

  it('reads the ignore rules from head, not base', async () => {
    expect(
      await brief({
        base: { 'README.md': '`tmp/a.txt`', 'tmp/a.txt': F, '.gitignore': 'tmp/\n' },
        head: { 'README.md': '`tmp/a.txt`' },
      }),
    ).toEqual(['tmp/a.txt -> none']);
  });

  it('applies a nested .gitignore only below its directory, relative to it', async () => {
    const head = {
      'README.md': '`packages/a/cache/x.bin` `cache/y.bin` `packages/a/sub/cache/z.bin`',
      'packages/a/.gitignore': 'cache/\n',
    };
    const base = {
      ...head,
      'packages/a/cache/x.bin': F,
      'cache/y.bin': F,
      'packages/a/sub/cache/z.bin': F,
    };
    expect(await brief({ base, head })).toEqual(['cache/y.bin -> none']);
  });

  it('lets a deeper .gitignore re-include what an outer one ignores', async () => {
    const head = {
      'README.md': '`pkg/keep.log` `pkg/drop.log`',
      '.gitignore': '*.log\n',
      'pkg/.gitignore': '!keep.log\n',
    };
    const base = { ...head, 'pkg/keep.log': F, 'pkg/drop.log': F };
    expect(await brief({ base, head })).toEqual(['pkg/keep.log -> none']);
  });

  it('flags a removed ignored-looking path when head does not ignore it', async () => {
    expect(await brief(gone('notes/dist.md'))).toEqual(['notes/dist.md -> none']);
  });
});

describe('pathRule: submodules', () => {
  it('counts a path inside a submodule as resolving while the submodule stays', async () => {
    expect(
      await brief({
        base: { 'README.md': '`vendor/lib/src/a.c`' },
        head: { 'README.md': '`vendor/lib/src/a.c`' },
        baseOptions: { submodules: ['vendor/lib'] },
        headOptions: { submodules: ['vendor/lib'] },
      }),
    ).toEqual([]);
  });

  it('flags a path inside a submodule that was removed', async () => {
    expect(
      await brief({
        base: { 'README.md': '`vendor/lib/src/a.c`' },
        head: { 'README.md': '`vendor/lib/src/a.c`' },
        baseOptions: { submodules: ['vendor/lib'] },
      }),
    ).toEqual(['vendor/lib/src/a.c -> none']);
  });

  it('does not let a submodule make unrelated paths exist', async () => {
    expect(
      await brief({
        base: { 'README.md': '`vendor/other/a.c` `vendor/lib2/a.c`' },
        head: { 'README.md': '`vendor/other/a.c` `vendor/lib2/a.c`' },
        baseOptions: { submodules: ['vendor/lib'] },
      }),
    ).toEqual([]);
  });

  it('counts the submodule path itself as existing', async () => {
    expect(
      await brief({
        base: { 'README.md': '`vendor/lib/`' },
        head: { 'README.md': '`vendor/lib/`' },
        baseOptions: { submodules: ['vendor/lib'] },
        headOptions: { submodules: ['vendor/lib'] },
      }),
    ).toEqual([]);
  });
});

describe('pathRule: suggestion style', () => {
  const rename = (
    doc: string,
    docPath: string,
    from: string,
    to: string,
    extra: Partial<Scenario> = {},
  ): Scenario => ({
    base: { [docPath]: doc, [from]: F, ...(extra.base ?? {}) },
    head: { [docPath]: doc, [to]: F, ...(extra.head ?? {}) },
    changes: { renamed: [{ from, to }], ...(extra.changes ?? {}) },
  });

  it('keeps a doc-relative path doc-relative', async () => {
    expect(await brief(rename('[g](guide.md)', 'docs/index.md', 'docs/guide.md', 'docs/handbook.md'))).toEqual([
      'docs/guide.md -> handbook.md',
    ]);
    expect(await brief(rename('[g](guide.md)', 'docs/index.md', 'docs/guide.md', 'manual/guide.md'))).toEqual([
      'docs/guide.md -> ../manual/guide.md',
    ]);
  });

  it('keeps a leading ./', async () => {
    expect(await brief(rename('[g](./guide.md)', 'docs/index.md', 'docs/guide.md', 'docs/handbook.md'))).toEqual([
      'docs/guide.md -> ./handbook.md',
    ]);
    expect(await brief(rename('See `./src/old.ts`', 'README.md', 'src/old.ts', 'lib/new.ts'))).toEqual([
      'src/old.ts -> ./lib/new.ts',
    ]);
  });

  it('does not add ./ in front of ../', async () => {
    expect(await brief(rename('[g](./guide.md)', 'docs/index.md', 'docs/guide.md', 'manual/guide.md'))).toEqual([
      'docs/guide.md -> ../manual/guide.md',
    ]);
  });

  it('keeps a root-anchored path root-anchored', async () => {
    expect(await brief(rename('[g](/docs/a.md)', 'README.md', 'docs/a.md', 'docs/b.md'))).toEqual([
      'docs/a.md -> /docs/b.md',
    ]);
  });

  it('keeps a trailing slash', async () => {
    const result = await brief({
      base: { 'README.md': '`src/old/`', 'src/old/a.ts': F },
      head: { 'README.md': '`src/old/`', 'src/new/a.ts': F },
      changes: { renamedDirs: [{ from: 'src/old', to: 'src/new' }], renamed: [{ from: 'src/old/a.ts', to: 'src/new/a.ts' }] },
    });
    expect(result).toEqual(['src/old -> src/new/']);
  });

  it('expresses a package-root match relative to the package', async () => {
    expect(
      await brief(
        rename('`src/index.ts`', 'packages/a/README.md', 'packages/a/src/index.ts', 'packages/b/src/index.ts', {
          base: { 'packages/a/package.json': '{}' },
          head: { 'packages/a/package.json': '{}' },
        }),
      ),
    ).toEqual(['packages/a/src/index.ts -> ../b/src/index.ts']);
  });

  it('rewrites the prefix of a renamed directory', async () => {
    expect(
      await brief({
        base: { 'README.md': '`src/old/deep/a.ts`', 'src/old/deep/a.ts': F, 'src/old/b.ts': F },
        head: { 'README.md': '`src/old/deep/a.ts`', 'lib/deep/a.ts': F, 'lib/b.ts': F },
        changes: {
          renamed: [
            { from: 'src/old/deep/a.ts', to: 'lib/deep/a.ts' },
            { from: 'src/old/b.ts', to: 'lib/b.ts' },
          ],
          renamedDirs: [{ from: 'src/old', to: 'lib' }],
        },
      }),
    ).toEqual(['src/old/deep/a.ts -> lib/deep/a.ts']);
  });

  it('prefers the longest renamed directory prefix', async () => {
    const result = await findings({
      base: { 'README.md': '`a/b/c.ts`', 'a/b/c.ts': F },
      head: { 'README.md': '`a/b/c.ts`' },
      changes: {
        renamedDirs: [
          { from: 'a', to: 'x' },
          { from: 'a/b', to: 'y' },
        ],
      },
    });
    expect(result[0]?.suggestion).toBe('y/c.ts');
    expect(result[0]?.message).toBe('`a/b/c.ts` was renamed to `y/c.ts` in this change');
  });

  it('does not match a directory prefix on a partial segment', async () => {
    const result = await findings({
      base: { 'README.md': '`src/older/a.ts`', 'src/older/a.ts': F },
      head: { 'README.md': '`src/older/a.ts`' },
      changes: { renamedDirs: [{ from: 'src/old', to: 'lib' }] },
    });
    expect(result[0]?.suggestion).toBeUndefined();
  });

  it('prefers an exact file rename over a directory rename', async () => {
    const result = await findings({
      base: { 'README.md': '`src/old/a.ts`', 'src/old/a.ts': F },
      head: { 'README.md': '`src/old/a.ts`' },
      changes: {
        renamed: [{ from: 'src/old/a.ts', to: 'elsewhere/a.ts' }],
        renamedDirs: [{ from: 'src/old', to: 'lib' }],
      },
    });
    expect(result[0]?.suggestion).toBe('elsewhere/a.ts');
  });

  it('gives no suggestion for a GitHub URL token, whose text is not a path', async () => {
    const result = await findings({
      base: { 'README.md': '[a](https://github.com/o/n/blob/main/src/old.ts)', 'src/old.ts': F },
      head: { 'README.md': '[a](https://github.com/o/n/blob/main/src/old.ts)', 'lib/new.ts': F },
      changes: { renamed: [{ from: 'src/old.ts', to: 'lib/new.ts' }] },
      repo: { owner: 'o', name: 'n' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe('`src/old.ts` was renamed to `lib/new.ts` in this change');
    expect(result[0]?.suggestion).toBeUndefined();
  });
});

describe('pathRule: links GitHub resolves doc-relative only', () => {
  const mono = (doc: string, extra: Files = {}): Scenario => ({
    base: { 'package.json': '{}', 'packages/ui/package.json': '{}', 'packages/ui/README.md': doc, 'CONTRIBUTING.md': F, ...extra },
    head: { 'package.json': '{}', 'packages/ui/package.json': '{}', 'packages/ui/README.md': doc, '.github/CONTRIBUTING.md': F },
    changes: { renamed: [{ from: 'CONTRIBUTING.md', to: '.github/CONTRIBUTING.md' }] },
  });

  it.each([
    ['link', '[guide](CONTRIBUTING.md)'],
    ['image', '![guide](CONTRIBUTING.md)'],
    ['definition', '[guide]: CONTRIBUTING.md\n\n[guide]'],
  ])('does not flag a %s that only the repo-root fallback resolved (already broken on GitHub)', async (_label, doc) => {
    expect(await brief(mono(doc))).toEqual([]);
  });

  it('does not flag a link that only the package-root fallback resolved', async () => {
    const result = await brief({
      base: { 'packages/a/package.json': '{}', 'packages/a/docs/g.md': '[x](src/i.ts)', 'packages/a/src/i.ts': F },
      head: { 'packages/a/package.json': '{}', 'packages/a/docs/g.md': '[x](src/i.ts)' },
    });
    expect(result).toEqual([]);
  });

  it('still flags a fallback match with a directory part for inline code, which is not a link', async () => {
    const doc = 'See `docs/guide.md`.';
    expect(
      await brief({
        base: { 'packages/ui/README.md': doc, 'docs/guide.md': F },
        head: { 'packages/ui/README.md': doc, 'docs/handbook.md': F },
        changes: { renamed: [{ from: 'docs/guide.md', to: 'docs/handbook.md' }] },
      }),
    ).toEqual(['docs/guide.md -> docs/handbook.md']);
  });

  it('still flags a doc-relative link, and a root-anchored one', async () => {
    expect(
      await brief({
        base: { 'docs/a.md': '[x](old.md) [y](/docs/old.md)', 'docs/old.md': F },
        head: { 'docs/a.md': '[x](old.md) [y](/docs/old.md)' },
      }),
    ).toEqual(['docs/old.md -> none', 'docs/old.md -> none']);
  });
});

describe('pathRule: bare names reached only through the fallback', () => {
  const nested = (doc: string, removed = 'renovate.json'): Scenario => ({
    base: { 'presets/README.md': doc, [removed]: F },
    head: { 'presets/README.md': doc },
    changes: { deleted: [removed] },
  });

  it.each([
    ['a file name', 'Add a `renovate.json` to your repository.', 'renovate.json'],
    ['a ./ name', 'Copy `./renovate.json`.', 'renovate.json'],
    ['a directory name', 'Write the files to `tmp/`.', 'tmp/x.go'],
  ])('does not flag %s that only the repo-root fallback resolved', async (_label, doc, removed) => {
    expect(await brief(nested(doc, removed))).toEqual([]);
  });

  it('does not flag a bare name that only the package-root fallback resolved', async () => {
    expect(
      await brief({
        base: { 'web/package.json': '{}', 'web/docs/setup.md': '`tailwind.config.js`', 'web/tailwind.config.js': F },
        head: { 'web/package.json': '{}', 'web/docs/setup.md': '`tailwind.config.js`' },
        changes: { deleted: ['web/tailwind.config.js'] },
      }),
    ).toEqual([]);
  });

  it('does not flag a bare name of the root contributing guide from a nested README (the accepted cost)', async () => {
    expect(
      await brief({
        base: { 'packages/ui/README.md': 'See `CONTRIBUTING.md`.', 'CONTRIBUTING.md': F },
        head: { 'packages/ui/README.md': 'See `CONTRIBUTING.md`.', '.github/CONTRIBUTING.md': F },
        changes: { renamed: [{ from: 'CONTRIBUTING.md', to: '.github/CONTRIBUTING.md' }] },
      }),
    ).toEqual([]);
  });

  it('still flags a bare name next to the doc', async () => {
    expect(await brief(nested('Edit `notes.md`.', 'presets/notes.md'))).toEqual(['presets/notes.md -> none']);
  });

  it('still flags a bare name in a root-level doc, whose own directory is the root', async () => {
    expect(
      await brief({
        base: { 'README.md': 'Edit `renovate.json`.', 'renovate.json': F },
        head: { 'README.md': 'Edit `renovate.json`.' },
        changes: { deleted: ['renovate.json'] },
      }),
    ).toEqual(['renovate.json -> none']);
  });

  it('still flags a root-anchored link and a same-repo URL', async () => {
    const doc = 'Edit [it](/renovate.json).\n\nOr [it](https://github.com/o/r/blob/main/renovate.json).';
    expect(await brief({ ...nested(doc), repo: { owner: 'o', name: 'r' } })).toEqual([
      'renovate.json -> none',
      'renovate.json -> none',
    ]);
  });
});

describe('pathRule: suggestion keeps the suffix and the encoding', () => {
  const sug = async (doc: string, from: string, to: string, docPath = 'README.md'): Promise<string[]> =>
    (
      await findings({
        base: { [docPath]: doc, [from]: F },
        head: { [docPath]: doc, [to]: F },
        changes: { renamed: [{ from, to }] },
      })
    ).map((f) => f.suggestion ?? 'none');

  it.each([
    ['[a](docs/a.md#install)', 'docs/b.md#install'],
    ['[a](docs/a.md?plain=1#L3)', 'docs/b.md?plain=1#L3'],
    ['[a](docs/a.md?x=1)', 'docs/b.md?x=1'],
    ['[a]: docs/a.md#top', 'docs/b.md#top'],
    ['![a](docs/a.md#x "title")', 'docs/b.md#x'],
    ['See `docs/a.md#install`.', 'docs/b.md#install'],
    ['See `docs/a.md:12`.', 'docs/b.md:12'],
    ['See `docs/a.md:12:3`.', 'docs/b.md:12:3'],
    ['See `docs/a.md:12#frag`.', 'docs/b.md:12#frag'],
    ['See docs/a.md#install for details.', 'docs/b.md#install'],
  ])('keeps the suffix of %j', async (doc, expected) => {
    expect(await sug(doc, 'docs/a.md', 'docs/b.md')).toEqual([expected]);
  });

  it('adds nothing after a path followed by punctuation', async () => {
    expect(await sug('See `docs/a.md`, then `docs/a.md`.', 'docs/a.md', 'docs/b.md')).toEqual(['docs/b.md', 'docs/b.md']);
    expect(await sug('Read docs/a.md.', 'docs/a.md', 'docs/b.md')).toEqual(['docs/b.md']);
  });

  it('percent-encodes a new path with spaces in a link', async () => {
    expect(await sug('[a](docs/a.md)', 'docs/a.md', 'docs/b c.md')).toEqual(['docs/b%20c.md']);
    expect(await sug('![a](docs/a.md)', 'docs/a.md', 'docs/b c.md')).toEqual(['docs/b%20c.md']);
    expect(await sug('[a]: docs/a.md', 'docs/a.md', 'docs/b c.md')).toEqual(['docs/b%20c.md']);
  });

  it('percent-encodes parentheses and hashes of a new path in a link', async () => {
    expect(await sug('[a](docs/a.md)', 'docs/a.md', 'docs/b (1)#.md')).toEqual(['docs/b%20%281%29%23.md']);
  });

  it('percent-encodes when the original was encoded, and keeps the suffix', async () => {
    expect(await sug('[a](docs/Getting%20Started.md#linux)', 'docs/Getting Started.md', 'docs/Quickstart.md')).toEqual([
      'docs/Quickstart.md#linux',
    ]);
    expect(await sug('[a](docs/Getting%20Started.md#linux)', 'docs/Getting Started.md', 'docs/Start Here.md')).toEqual([
      'docs/Start%20Here.md#linux',
    ]);
  });

  it('keeps an unencoded link unencoded when nothing needs encoding (non-ASCII included)', async () => {
    expect(await sug('[a](docs/a.md)', 'docs/a.md', 'docs/guía.md')).toEqual(['docs/guía.md']);
  });

  it('does not encode paths in code', async () => {
    expect(await sug('See `docs/a.md`.', 'docs/a.md', 'docs/b c.md')).toEqual(['docs/b c.md']);
  });

  it('reads an angle-bracketed link destination up to the closing bracket', async () => {
    expect(await sug('[a](<docs/a.md#x y>)', 'docs/a.md', 'docs/b.md')).toEqual(['docs/b.md#x y']);
  });

  it('gives no suggestion for a destination holding parentheses', async () => {
    expect(await sug('[a](docs/a(1).md)', 'docs/a(1).md', 'docs/b.md')).toEqual(['none']);
  });
});

describe('pathRule: fingerprint stability', () => {
  const doc = (...lines: string[]) => lines.join('\n');
  const scenario = (readme: string): Scenario => ({
    base: { 'README.md': readme, 'src/old.ts': F },
    head: { 'README.md': readme },
  });

  it('is stable across unrelated edits elsewhere in the file', async () => {
    const line = 'Run `src/old.ts` to start.';
    const [a] = await findings(scenario(doc('# Title', '', line)));
    const [b] = await findings(scenario(doc('# A longer title', 'New intro paragraph.', 'Another one.', '', line, '', 'Trailing.')));
    expect(a?.line).toBe(3);
    expect(b?.line).toBe(5);
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });

  it('changes when the line itself changes', async () => {
    const [a] = await findings(scenario('Run `src/old.ts` to start.'));
    const [b] = await findings(scenario('Execute `src/old.ts` to start.'));
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
  });

  it('differs between two references on different lines', async () => {
    const result = await findings(scenario(doc('`src/old.ts` here', '`src/old.ts` there')));
    expect(result).toHaveLength(2);
    expect(result[0]?.fingerprint).not.toBe(result[1]?.fingerprint);
  });
});
