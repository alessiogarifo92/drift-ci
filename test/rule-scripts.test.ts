import { describe, expect, it } from 'vitest';
import { npmScriptRule } from '../src/core/rules/scripts.ts';
import { briefOf, findingsOf, pkg, runRule, type Files } from './helpers/run-rule.ts';

const rule = npmScriptRule;
const fence = (...lines: string[]) => ['```sh', ...lines, '```'].join('\n');

/** Root package + two workspace packages, `build` defined everywhere. */
function monorepo(overrides: Files = {}): Files {
  return {
    'package.json': pkg({ name: 'root', private: true, workspaces: ['packages/*'], scripts: { build: 'turbo run build' } }),
    'packages/a/package.json': pkg({ name: '@acme/a', scripts: { build: 'tsc -p a', test: 'vitest' } }),
    'packages/b/package.json': pkg({ name: 'b', scripts: { build: 'tsc -p b' } }),
    'README.md': 'x',
    ...overrides,
  };
}

describe('npmScriptRule: what is drift', () => {
  it('flags a script removed in head, without suggestion, keyed by (package.json, name)', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { 'package.json': pkg({ name: 'app', scripts: { build: 'tsc', lint: 'eslint .' } }), 'README.md': 'Run `npm run build`.' },
      head: { 'package.json': pkg({ name: 'app', scripts: { lint: 'eslint .' } }), 'README.md': 'Run `npm run build`.' },
    });
    expect(finding).toMatchObject({
      ruleId: 'npm-script',
      kind: 'npm-script',
      fact: 'package.json#build',
      file: 'README.md',
      line: 1,
      col: 14,
      message: 'npm script `build` (package `app`) was removed in this change',
    });
    expect(finding && 'suggestion' in finding).toBe(false);
  });

  it('suggests the new name when exactly one script was renamed with the same command', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { 'package.json': pkg({ name: 'app', scripts: { build: ' tsc -p . ', lint: 'eslint' } }), 'README.md': '`npm run build`' },
      head: { 'package.json': pkg({ name: 'app', scripts: { compile: 'tsc -p .', lint: 'eslint' } }), 'README.md': '`npm run build`' },
    });
    expect(finding?.message).toBe('npm script `build` (package `app`) was renamed to `compile` in this change');
    expect(finding?.suggestion).toBe('compile');
  });

  it.each([
    ['a different command', { compile: 'tsc --noEmit' }],
    ['two added scripts', { compile: 'tsc', compile2: 'tsc' }],
  ])('does not suggest with %s', async (_name, added) => {
    const [finding] = await findingsOf(rule(), {
      base: { 'package.json': pkg({ name: 'app', scripts: { build: 'tsc' } }), 'README.md': '`npm run build`' },
      head: { 'package.json': pkg({ name: 'app', scripts: added }), 'README.md': '`npm run build`' },
    });
    expect(finding?.message).toContain('was removed in this change');
    expect(finding && 'suggestion' in finding).toBe(false);
  });

  it('does not suggest when two scripts were removed', async () => {
    const result = await briefOf(rule(), {
      base: { 'package.json': pkg({ scripts: { a: 'x', b: 'x' } }), 'README.md': '`npm run a`' },
      head: { 'package.json': pkg({ scripts: { c: 'x' } }), 'README.md': '`npm run a`' },
    });
    expect(result).toEqual(['package.json#a -> none']);
  });

  it('labels a package without a name by its package.json path', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { 'sub/package.json': pkg({ scripts: { build: 'x' } }), 'sub/README.md': '`npm run build`' },
      head: { 'sub/package.json': pkg({ scripts: {} }), 'sub/README.md': '`npm run build`' },
    });
    expect(finding?.message).toBe('npm script `build` (package `sub/package.json`) was removed in this change');
  });

  it('never flags a script that did not exist in base', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'package.json': pkg({ scripts: { lint: 'x' } }), 'README.md': '`npm run build`' },
        head: { 'package.json': pkg({ scripts: { lint: 'x' } }), 'README.md': '`npm run build`' },
      }),
    ).toEqual([]);
  });

  it('does not flag a script that still exists', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'package.json': pkg({ scripts: { build: 'x' } }), 'README.md': '`npm run build`' },
        head: { 'package.json': pkg({ scripts: { build: 'y' } }), 'README.md': '`npm run build`' },
      }),
    ).toEqual([]);
  });

  it('does not flag a doc without any package.json above it', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'tools/package.json': pkg({ scripts: { build: 'x' } }), 'README.md': '`npm run build`' },
        head: { 'tools/package.json': pkg({ scripts: {} }), 'README.md': '`npm run build`' },
      }),
    ).toEqual([]);
  });

  it('flags when the whole package.json is gone in head', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'package.json': pkg({ scripts: { build: 'x' } }), 'README.md': '`npm run build`' },
        head: { 'README.md': '`npm run build`' },
      }),
    ).toEqual(['package.json#build -> none']);
  });

  it('flags one finding per reference', async () => {
    const result = await findingsOf(rule(), {
      base: { 'package.json': pkg({ scripts: { build: 'x', lint: 'y' } }), 'README.md': '`npm run build` and `npm run lint`' },
      head: { 'package.json': pkg({ scripts: {} }), 'README.md': '`npm run build` and `npm run lint`' },
    });
    expect(result.map((f) => f.fact)).toEqual(['package.json#build', 'package.json#lint']);
  });
});

describe('npmScriptRule: package resolution', () => {
  const removeFrom = (path: string, scripts: Record<string, string>): Files => ({
    [path]: pkg({ name: 'x', scripts }),
  });

  it('uses the nearest package.json above the doc', async () => {
    const head = monorepo({
      ...removeFrom('packages/a/package.json', { test: 'vitest' }),
      'packages/a/README.md': '`npm run build`',
      'packages/b/README.md': '`npm run build`',
    });
    const base = monorepo({ 'packages/a/README.md': '`npm run build`', 'packages/b/README.md': '`npm run build`' });
    const result = await findingsOf(rule(), { base, head });
    expect(result.map((f) => [f.file, f.fact])).toEqual([['packages/a/README.md', 'packages/a/package.json#build']]);
  });

  it('finds the nearest package.json from a nested doc directory', async () => {
    const base = monorepo({ 'packages/a/docs/guide.md': '`npm run build`' });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'packages/a/docs/guide.md': '`npm run build`' });
    expect((await briefOf(rule(), { base, head })).join()).toBe('packages/a/package.json#build -> none');
  });

  it('falls back to the root package.json', async () => {
    const base = monorepo({ 'docs/guide.md': '`npm run build`' });
    const head = monorepo({ 'package.json': pkg({ name: 'root', scripts: {} }), 'docs/guide.md': '`npm run build`' });
    expect(await briefOf(rule(), { base, head })).toEqual(['package.json#build -> none']);
  });

  it('follows a package.json that moved: the head resolution wins when the old one is gone', async () => {
    const base = monorepo({ 'packages/a/README.md': '`npm run build`' });
    const head = monorepo({ 'packages/a/README.md': '`npm run build`' });
    delete head['packages/a/package.json']; // root still defines build
    expect(await briefOf(rule(), { base, head })).toEqual([]);
  });

  it('uses a relative cwd of the doc (cd) instead of the doc directory', async () => {
    const doc = fence('cd packages/a', 'npm run build');
    const base = monorepo({ 'README.md': doc });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'README.md': doc });
    expect(await briefOf(rule(), { base, head })).toEqual(['packages/a/package.json#build -> none']);
  });

  it('resolves cwd relative to the doc directory', async () => {
    const doc = fence('cd ../packages/a && npm run build');
    const base = monorepo({ 'docs/guide.md': doc });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'docs/guide.md': doc });
    expect(await briefOf(rule(), { base, head })).toEqual(['packages/a/package.json#build -> none']);
  });

  it('uses npm --prefix as cwd', async () => {
    const doc = '`npm --prefix packages/a run build`';
    const base = monorepo({ 'README.md': doc });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'README.md': doc });
    expect(await briefOf(rule(), { base, head })).toEqual(['packages/a/package.json#build -> none']);
  });

  it.each([
    ['npm -w packages/a run build', 'packages/a/package.json#build -> none'],
    ['npm --workspace=packages/a run build', 'packages/a/package.json#build -> none'],
    ['npm -w @acme/a run build', 'packages/a/package.json#build -> none'],
    ['npm -w a run build', 'packages/a/package.json#build -> none'],
    ['pnpm --filter ./packages/a build', 'packages/a/package.json#build -> none'],
    ['pnpm --filter @acme/a run build', 'packages/a/package.json#build -> none'],
    ['pnpm -F @acme/a build', 'packages/a/package.json#build -> none'],
    ['yarn workspace @acme/a build', 'packages/a/package.json#build -> none'],
  ])('resolves the workspace of `%s`', async (command, expected) => {
    const doc = `\`${command}\``;
    const base = monorepo({ 'README.md': doc });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'README.md': doc });
    // The head package lost its name too: the lookup falls back to the directory.
    expect(await briefOf(rule(), { base, head })).toEqual([expected]);
  });

  it('flags a workspace script only for the targeted workspace', async () => {
    const doc = '`npm -w b run build`';
    const base = monorepo({ 'README.md': doc });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'README.md': doc });
    expect(await briefOf(rule(), { base, head })).toEqual([]);
  });

  it('does not flag a workspace it cannot find in base', async () => {
    const doc = '`npm -w nope run build`';
    expect(await briefOf(rule(), { base: monorepo({ 'README.md': doc }), head: monorepo({ 'package.json': pkg({ scripts: {} }), 'README.md': doc }) })).toEqual([]);
  });

  it('does not flag a pnpm glob filter', async () => {
    const doc = "`pnpm --filter './packages/*' build`";
    const base = monorepo({ 'README.md': doc });
    const head = monorepo({ ...removeFrom('packages/a/package.json', {}), 'README.md': doc });
    expect(await briefOf(rule(), { base, head })).toEqual([]);
  });

  it('flags a workspace that disappeared in head', async () => {
    const doc = '`npm -w b run build`';
    const base = monorepo({ 'README.md': doc });
    const head = monorepo({ 'README.md': doc });
    delete head['packages/b/package.json'];
    expect(await briefOf(rule(), { base, head })).toEqual(['packages/b/package.json#build -> none']);
  });

  it.each(['cd /srv/app && npm run build', 'cd ~/app && npm run build', 'cd $APP_DIR && npm run build', 'cd ../.. && npm run build'])(
    'ignores a cwd it cannot place: %s',
    async (line) => {
      const doc = fence(line);
      const base = { 'package.json': pkg({ scripts: { build: 'x' } }), 'README.md': doc };
      const head = { 'package.json': pkg({ scripts: {} }), 'README.md': doc };
      expect(await briefOf(rule(), { base, head })).toEqual([]);
    },
  );

  it('ignores a package.json under node_modules', async () => {
    const base = { 'node_modules/dep/package.json': pkg({ scripts: { build: 'x' } }), 'node_modules/dep/README.md': '`npm run build`' };
    const head = { 'node_modules/dep/package.json': pkg({ scripts: {} }), 'node_modules/dep/README.md': '`npm run build`' };
    expect(await briefOf(rule(), { base, head })).toEqual([]);
  });
});

describe('npmScriptRule: implicit scripts', () => {
  it.each(['test', 'start', 'stop', 'restart'])('flags `npm %s` only when base defined it and head does not', async (name) => {
    const doc = `\`npm ${name}\``;
    const defined = { 'package.json': pkg({ scripts: { [name]: 'x' } }), 'README.md': doc };
    const none = { 'package.json': pkg({ scripts: {} }), 'README.md': doc };
    expect(await briefOf(rule(), { base: defined, head: none })).toEqual([`package.json#${name} -> none`]);
    expect(await briefOf(rule(), { base: none, head: none })).toEqual([]);
    expect(await briefOf(rule(), { base: none, head: defined })).toEqual([]);
    expect(await briefOf(rule(), { base: defined, head: defined })).toEqual([]);
  });

  it('flags the short alias `npm t` as the test script', async () => {
    const base = { 'package.json': pkg({ scripts: { test: 'x' } }), 'README.md': '`npm t`' };
    const head = { 'package.json': pkg({ scripts: {} }), 'README.md': '`npm t`' };
    expect(await briefOf(rule(), { base, head })).toEqual(['package.json#test -> none']);
  });
});

describe('npmScriptRule: invalid package.json', () => {
  const doc = { 'README.md': '`npm run build`' };
  const valid = { 'package.json': pkg({ name: 'app', scripts: { build: 'x' } }), ...doc };

  it('warns and flags nothing when the head package.json is invalid', async () => {
    const result = await runRule(rule(), { base: valid, head: { 'package.json': '{ "scripts": ', ...doc }, changes: { modified: ['package.json'] } });
    expect(result.findings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^package\.json: invalid package\.json \(.+\); its scripts and bins are ignored$/);
  });

  it('warns and flags nothing when the base package.json is invalid', async () => {
    const result = await runRule(rule(), { base: { 'package.json': 'nope', ...doc }, head: valid, changes: { modified: ['package.json'] } });
    expect(result.findings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('warns once when both sides are invalid in the same way', async () => {
    const bad = { 'package.json': '{', ...doc };
    expect((await runRule(rule(), { base: bad, head: bad, changes: { modified: ['package.json'] } })).warnings).toHaveLength(1);
  });

  it('reports a non-object package.json', async () => {
    const result = await runRule(rule(), { base: valid, head: { 'package.json': '[]', ...doc }, changes: { modified: ['package.json'] } });
    expect(result.warnings).toEqual(['package.json: invalid package.json (not a JSON object); its scripts and bins are ignored']);
    expect(result.findings).toEqual([]);
  });

  it('keeps resolving other packages', async () => {
    const base = monorepo({ 'packages/b/README.md': '`npm run build`' });
    const head = monorepo({ 'packages/a/package.json': '{', 'packages/b/package.json': pkg({ name: 'b' }), 'packages/b/README.md': '`npm run build`' });
    const result = await runRule(rule(), { base, head, changes: { added: ['packages/a/package.json'] } });
    expect(result.findings.map((f) => f.fact)).toEqual(['packages/b/package.json#build']);
    expect(result.warnings).toHaveLength(1);
  });

  it('stays silent about an invalid package.json the diff did not touch', async () => {
    const bad = { 'package.json': '{ nope', ...doc };
    const result = await runRule(rule(), { base: bad, head: bad, changes: { modified: ['README.md'] } });
    expect(result.warnings).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it.each([
    ['added', { added: ['package.json'] }],
    ['modified', { modified: ['package.json'] }],
    ['renamed to', { renamed: [{ from: 'old/package.json', to: 'package.json' }] }],
  ])('warns when the diff %s the invalid package.json', async (_label, changes) => {
    const result = await runRule(rule(), { base: valid, head: { 'package.json': '{', ...doc }, changes });
    expect(result.warnings).toHaveLength(1);
  });

  it('does not warn when the invalid package.json was only deleted or renamed away', async () => {
    const bad = { 'package.json': '{', ...doc };
    const result = await runRule(rule(), {
      base: bad,
      head: { ...doc },
      changes: { deleted: ['package.json'], renamed: [{ from: 'package.json', to: 'x/other.txt' }] },
    });
    expect(result.warnings).toEqual([]);
  });
});

describe('npmScriptRule: packages under fixtures, vendor and excluded paths', () => {
  const rootDoc = { 'README.md': '`npm run build`' };
  const pkgs = (extra: Files): Files => ({ 'package.json': pkg({ name: 'root', scripts: { build: 'x' } }), ...rootDoc, ...extra });

  it.each(['test/fixtures/a/package.json', 'x/__fixtures__/a/package.json', 'testdata/a/package.json', 'vendor/a/package.json'])(
    'does not warn about, nor read, %s',
    async (path) => {
      const result = await runRule(rule(), {
        base: pkgs({}),
        head: pkgs({ [path]: '{ broken' }),
        changes: { added: [path] },
      });
      expect(result.warnings).toEqual([]);
    },
  );

  it('does not resolve a doc to a fixture package.json', async () => {
    const result = await briefOf(rule(), {
      base: pkgs({ 'test/fixtures/a/package.json': pkg({ name: 'f', scripts: { build: 'x' } }), 'test/fixtures/a/README.md': '`npm run build`' }),
      head: pkgs({ 'test/fixtures/a/package.json': pkg({ name: 'f', scripts: {} }), 'test/fixtures/a/README.md': '`npm run build`' }),
    });
    expect(result).toEqual([]);
  });

  it('does not read a package.json matched by docs.exclude', async () => {
    const result = await runRule(rule(), {
      base: pkgs({}),
      head: pkgs({ 'generated/a/package.json': '{ broken' }),
      changes: { added: ['generated/a/package.json'] },
      exclude: ['generated/**'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('still reads packages under examples and test directories', async () => {
    const result = await runRule(rule(), {
      base: pkgs({}),
      head: pkgs({ 'examples/a/package.json': '{ broken', 'test/a/package.json': '{ broken' }),
      changes: { added: ['examples/a/package.json', 'test/a/package.json'] },
    });
    expect(result.warnings).toHaveLength(2);
  });
});

describe('npmScriptRule: runs across every workspace', () => {
  const root = (scripts: Record<string, string>) => pkg({ name: 'root', private: true, workspaces: ['packages/*'], scripts });

  it.each([
    'pnpm -r build',
    'pnpm --recursive run build',
    'npm run build --workspaces',
    'npm run build -ws',
    'pnpm --filter "*" build',
    'pnpm --filter ./packages/* run build',
    'pnpm -F @acme/* build',
  ])('does not flag `%s` when only the root lost the script', async (command) => {
    const doc = fence(command);
    const files = { 'packages/a/package.json': pkg({ name: 'a', scripts: { build: 'tsc' } }), 'README.md': doc };
    const result = await briefOf(rule(), {
      base: { ...files, 'package.json': root({ build: 'tsc -b', lint: 'x' }) },
      head: { ...files, 'package.json': root({ lint: 'x' }) },
    });
    expect(result).toEqual([]);
  });

  it('still flags the same script run in one workspace only', async () => {
    const doc = fence('pnpm --filter root build');
    const result = await briefOf(rule(), {
      base: { 'package.json': root({ build: 'x' }), 'README.md': doc },
      head: { 'package.json': root({}), 'README.md': doc },
    });
    expect(result).toEqual(['package.json#build -> none']);
  });

  it('does not flag in scan mode either', async () => {
    const r = rule();
    const files = { 'package.json': root({ lint: 'x' }), 'README.md': fence('pnpm -r run build', 'npm run build -ws') };
    const result = await runRule(r, { base: files, head: files });
    expect(result.findings).toEqual([]);
    const ref = {
      kind: 'npm-script' as const, normalized: 'build', file: 'README.md', line: 2, col: 13, source: 'fence' as const,
      contextLine: 'pnpm -r run build', shadow: false, context: { packageManager: 'pnpm' as const, allWorkspaces: true as const },
    };
    expect(r.scan?.(ref, { path: 'README.md' })).toBeUndefined();
  });
});

describe('npmScriptRule: lifecycle', () => {
  it('has its id, kinds and refuses check() before prepare()', () => {
    const r = rule();
    expect(r.id).toBe('npm-script');
    expect(r.kinds).toEqual(['npm-script']);
    expect(() =>
      r.check(
        { kind: 'npm-script', normalized: 'build', file: 'README.md', line: 1, col: 1, source: 'inline-code', contextLine: '', shadow: false },
        { path: 'README.md' },
      ),
    ).toThrow(/prepare/);
  });
});

describe('npmScriptRule: a package.json added between the doc and the base package', () => {
  // Seen dogfooding on this repo: a fixture directory added its own package.json
  // without `build`; its README resolved to the root package in base and to the new one in head.
  it('does not flag a script that still exists in the package base resolved to', async () => {
    const root = pkg({ name: 'root', scripts: { build: 'tsc' } });
    const findings = await findingsOf(rule(), {
      base: { 'package.json': root, 'README.md': 'x' },
      head: {
        'package.json': root,
        'examples/demo/package.json': pkg({ name: 'demo', scripts: { compile: 'tsc' } }),
        'examples/demo/README.md': 'Run `npm run build`.',
      },
    });
    expect(findings).toEqual([]);
  });

  it('still flags the script when the base package lost it too', async () => {
    const findings = await findingsOf(rule(), {
      base: { 'package.json': pkg({ name: 'root', scripts: { build: 'tsc' } }), 'examples/demo/README.md': 'Run `npm run build`.' },
      head: {
        'package.json': pkg({ name: 'root', scripts: {} }),
        'examples/demo/package.json': pkg({ name: 'demo', scripts: {} }),
        'examples/demo/README.md': 'Run `npm run build`.',
      },
    });
    expect(findings).toMatchObject([{ ruleId: 'npm-script', fact: 'package.json#build' }]);
  });
});
