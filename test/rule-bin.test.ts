import { describe, expect, it } from 'vitest';
import { binRule } from '../src/core/rules/bin.ts';
import { briefOf, findingsOf, pkg, runRule, type Files } from './helpers/run-rule.ts';

const rule = binRule;
const fence = (...lines: string[]) => ['```sh', ...lines, '```'].join('\n');
const doc = { 'README.md': fence('mytool init') };

describe('binRule: what is drift', () => {
  it('flags a bin that existed in base and is gone in head', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { 'package.json': pkg({ name: 'p', bin: { mytool: './cli.js' } }), ...doc },
      head: { 'package.json': pkg({ name: 'p' }), ...doc },
    });
    expect(finding).toMatchObject({
      ruleId: 'bin',
      kind: 'command',
      fact: 'bin:mytool',
      file: 'README.md',
      line: 2,
      col: 1,
      message: 'bin `mytool` was removed in this change',
    });
    expect(finding && 'suggestion' in finding).toBe(false);
  });

  it('suggests the new name when one bin was renamed in the same package.json and points to the same file', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { 'package.json': pkg({ name: 'p', bin: { mytool: './bin/cli.js', other: './bin/o.js' } }), ...doc },
      head: { 'package.json': pkg({ name: 'p', bin: { newtool: './bin/cli.js', other: './bin/o.js' } }), ...doc },
    });
    expect(finding?.message).toBe('bin `mytool` was renamed to `newtool` in this change');
    expect(finding?.suggestion).toBe('newtool');
  });

  it('compares files after dropping a leading ./', async () => {
    const result = await briefOf(rule(), {
      base: { 'package.json': pkg({ name: 'p', bin: { mytool: './cli.js' } }), ...doc },
      head: { 'package.json': pkg({ name: 'p', bin: { newtool: 'cli.js' } }), ...doc },
    });
    expect(result).toEqual(['bin:mytool -> newtool']);
  });

  it('does not suggest when the new bin points to another file', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'package.json': pkg({ name: 'p', bin: { mytool: './a.js' } }), ...doc },
        head: { 'package.json': pkg({ name: 'p', bin: { newtool: './b.js' } }), ...doc },
      }),
    ).toEqual(['bin:mytool -> none']);
  });

  it('does not suggest when two bins appeared', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'package.json': pkg({ name: 'p', bin: { mytool: './a.js' } }), ...doc },
        head: { 'package.json': pkg({ name: 'p', bin: { n1: './a.js', n2: './a.js' } }), ...doc },
      }),
    ).toEqual(['bin:mytool -> none']);
  });

  it('handles the string form: the bin is named after the package without its scope', async () => {
    const result = await briefOf(rule(), {
      base: { 'package.json': pkg({ name: '@acme/mytool', bin: './cli.js' }), ...doc },
      head: { 'package.json': pkg({ name: '@acme/newtool', bin: './cli.js' }), ...doc },
    });
    expect(result).toEqual(['bin:mytool -> newtool']);
  });

  it('does not flag a command that never was a bin', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'package.json': pkg({ name: 'p', bin: { other: './o.js' } }), ...doc },
        head: { 'package.json': pkg({ name: 'p' }), ...doc },
      }),
    ).toEqual([]);
  });

  it('does not flag a bin that still exists', async () => {
    const files = { 'package.json': pkg({ name: 'p', bin: { mytool: './cli.js' } }), ...doc };
    expect(await briefOf(rule(), { base: files, head: files })).toEqual([]);
  });

  it('treats bins as global: one that moved to another package is not flagged, nor suggested', async () => {
    const base: Files = { 'packages/a/package.json': pkg({ name: 'a', bin: { mytool: './x.js' } }), ...doc };
    const head: Files = {
      'packages/a/package.json': pkg({ name: 'a' }),
      'packages/b/package.json': pkg({ name: 'b', bin: { mytool: './x.js' } }),
      ...doc,
    };
    expect(await briefOf(rule(), { base, head })).toEqual([]);
  });

  it('flags a bin whose package.json was deleted, without suggestion', async () => {
    expect(
      await briefOf(rule(), { base: { 'package.json': pkg({ name: 'p', bin: { mytool: './x.js' } }), ...doc }, head: { ...doc } }),
    ).toEqual(['bin:mytool -> none']);
  });

  it('does not use node_modules packages', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'node_modules/x/package.json': pkg({ name: 'x', bin: { mytool: './x.js' } }), ...doc },
        head: { ...doc },
      }),
    ).toEqual([]);
  });
});

describe('binRule: invalid package.json', () => {
  it('warns and flags nothing when a package.json cannot be read', async () => {
    const result = await runRule(rule(), {
      base: { 'package.json': pkg({ name: 'p', bin: { mytool: './x.js' } }), ...doc },
      head: { 'package.json': '{oops', ...doc },
      changes: { modified: ['package.json'] },
    });
    expect(result.findings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^package\.json: invalid package\.json \(.+\); its scripts and bins are ignored$/);
  });
});

describe('binRule: fixtures and excluded paths do not count', () => {
  const real = { 'package.json': pkg({ name: 'plugin', devDependencies: { eslint: '9' } }), ...doc };

  it.each(['test/fixtures/p/package.json', 'a/__fixtures__/p/package.json', 'testdata/p/package.json', 'vendor/p/package.json'])(
    'a bin of %s is not a bin of this project',
    async (path) => {
      const withBin = { ...real, [path]: pkg({ name: 'fake', bin: { mytool: 'bin.js' } }) };
      expect(await briefOf(rule(), { base: withBin, head: real })).toEqual([]);
      // ...and the same bin in a real package is flagged.
      const flagged = { ...real, 'tools/p/package.json': pkg({ name: 'fake', bin: { mytool: 'bin.js' } }) };
      expect(await briefOf(rule(), { base: flagged, head: real })).toEqual(['bin:mytool -> none']);
    },
  );

  it('ignores the packages docs.exclude matches', async () => {
    const withBin = { ...real, 'generated/p/package.json': pkg({ name: 'fake', bin: { mytool: 'bin.js' } }) };
    expect(
      await briefOf(rule(), { base: withBin, head: real, exclude: ['generated/**'] }),
    ).toEqual([]);
  });
});

describe('binRule: lifecycle', () => {
  it('has its id, kinds and refuses check() before prepare()', () => {
    const r = rule();
    expect(r.id).toBe('bin');
    expect(r.kinds).toEqual(['command']);
    expect(() =>
      r.check(
        { kind: 'command', normalized: 'x', file: 'README.md', line: 1, col: 1, source: 'fence', contextLine: '', shadow: false },
        { path: 'README.md' },
      ),
    ).toThrow(/prepare/);
  });
});
