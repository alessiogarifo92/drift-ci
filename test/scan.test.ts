import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig } from '../src/core/config.ts';
import { defaultRules } from '../src/core/rules/index.ts';
import { scanSnapshot, type ScanOptions } from '../src/core/scan.ts';
import { envRule } from '../src/core/rules/env.ts';
import { binRule } from '../src/core/rules/bin.ts';
import { memorySnapshot } from './helpers/memory-snapshot.ts';
import { pkg, type Files } from './helpers/run-rule.ts';

const fence = (...lines: string[]) => ['```sh', ...lines, '```'].join('\n');

function scan(files: Files, options: Partial<ScanOptions> = {}) {
  return scanSnapshot(memorySnapshot(files, { commit: 'd'.repeat(40) }), { rules: defaultRules(), ...options });
}

/** `ruleId file:line message`, the essence of a scan finding. */
async function brief(files: Files, options: Partial<ScanOptions> = {}): Promise<string[]> {
  return (await scan(files, options)).findings.map((f) => `${f.ruleId} ${f.file}:${f.line} ${f.message}`);
}

describe('scanSnapshot: result', () => {
  it('has mode scan, the head commit and no base', async () => {
    const result = await scan({ 'README.md': 'See `src/missing.ts`.' });
    expect(result).toEqual({
      schemaVersion: 1,
      mode: 'scan',
      head: 'd'.repeat(40),
      findings: [expect.objectContaining({ ruleId: 'path', file: 'README.md', line: 1, col: 6 })],
      warnings: [],
      failOn: 'none',
    });
    expect(result).not.toHaveProperty('base');
  });

  it('carries the failOn of the config', async () => {
    const config = parseConfig('version: 1\nfailOn: warning\n');
    expect((await scan({ 'README.md': 'x' }, { config })).failOn).toBe('warning');
  });

  it('gives each finding a fingerprint, a fact and no suggestion', async () => {
    const [finding] = (await scan({ 'README.md': 'See `src/missing.ts`.' })).findings;
    expect(finding).toMatchObject({ kind: 'path', fact: 'src/missing.ts' });
    expect(finding?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(finding && 'suggestion' in finding).toBe(false);
  });

  it('is empty when nothing is documented', async () => {
    expect((await scan({ 'src/a.ts': 'x' })).findings).toEqual([]);
  });
});

describe('scanSnapshot: paths', () => {
  it('flags a path that does not exist at head', async () => {
    expect(await brief({ 'README.md': 'See `src/missing.ts`.' })).toEqual([
      'path README.md:1 `src/missing.ts` does not exist at this commit',
    ]);
  });

  it('does not flag a path that exists', async () => {
    expect(await brief({ 'README.md': 'See `src/a.ts` and [docs](docs/guide.md).', 'src/a.ts': '', 'docs/guide.md': '' })).toEqual([]);
  });

  it('resolves doc-relative, package-root and repo-root candidates', async () => {
    const files: Files = {
      'packages/a/package.json': pkg({ name: 'a' }),
      'packages/a/docs/guide.md': '[x](../src/index.ts), `lib/util.ts`, `scripts/run.sh`',
      'packages/a/src/index.ts': '',
      'packages/a/lib/util.ts': '',
      'scripts/run.sh': '',
    };
    expect(await brief(files)).toEqual([]);
  });

  it('counts a directory as existing', async () => {
    expect(await brief({ 'README.md': 'Code lives in `src/core/`.', 'src/core/a.ts': '' })).toEqual([]);
  });

  it('flags a link target that is missing', async () => {
    expect(await brief({ 'README.md': '[guide](docs/guide.md)' })).toEqual([
      'path README.md:1 `docs/guide.md` does not exist at this commit',
    ]);
  });

  it('does not flag a path under a build directory', async () => {
    expect(await brief({ 'README.md': 'Built into `dist/cli.js` and `packages/a/build/index.js`.' })).toEqual([]);
  });

  it('does not flag a path ignored by a .gitignore', async () => {
    const files: Files = {
      '.gitignore': 'generated/\n*.log\n',
      'README.md': 'Output in `generated/out.txt`, logs in `logs/app.log`, but `docs/removed.md` is gone.',
    };
    expect(await brief(files)).toEqual(['path README.md:1 `docs/removed.md` does not exist at this commit']);
  });

  it('honours a nested .gitignore only below its directory', async () => {
    const files: Files = {
      'tools/.gitignore': 'cache/\n',
      'README.md': 'See `tools/cache/x.txt` and `cache/x.txt`.',
    };
    expect(await brief(files)).toEqual(['path README.md:1 `cache/x.txt` does not exist at this commit']);
  });

  it('does not flag a path under a submodule', async () => {
    const snapshot = memorySnapshot({ 'README.md': 'See `vendor/lib/src/a.c`.' }, { submodules: ['vendor/lib'] });
    expect((await scanSnapshot(snapshot, { rules: defaultRules() })).findings).toEqual([]);
  });

  it('flags an extension-less path only inside a directory that exists, or with a trailing slash', async () => {
    const files: Files = {
      'README.md': 'Repo `acme/skills`, state `refs/pull/N/merge`, gone `src/olddir`, gone `docs/old/`, gone `nowhere/old/`.',
      'src/a.ts': '',
    };
    expect(await brief(files)).toEqual([
      'path README.md:1 `src/olddir` does not exist at this commit',
      'path README.md:1 `docs/old/` does not exist at this commit',
      'path README.md:1 `nowhere/old/` does not exist at this commit',
    ]);
  });

  it('does not flag a path that escapes the repository', async () => {
    expect(await brief({ 'README.md': '[x](../outside.md)' })).toEqual([]);
  });
});

describe('scanSnapshot: npm scripts', () => {
  const app = (scripts: Record<string, string>) => pkg({ name: 'app', scripts });

  it('flags an explicit `npm run` of a script the package lacks', async () => {
    const files = { 'package.json': app({ lint: 'eslint .' }), 'README.md': fence('npm run build') };
    expect(await brief(files)).toEqual([
      'npm-script README.md:2 npm script `build` (package `app`) does not exist at this commit',
    ]);
  });

  it('uses package.json#name as the fact', async () => {
    const files = { 'package.json': app({}), 'README.md': fence('npm run build') };
    expect((await scan(files)).findings.map((f) => f.fact)).toEqual(['package.json#build']);
  });

  it('does not flag a script the package defines', async () => {
    const files = { 'package.json': app({ build: 'tsc' }), 'README.md': fence('npm run build', 'pnpm run build') };
    expect(await brief(files)).toEqual([]);
  });

  it('flags `pnpm run x` as well', async () => {
    const files = { 'package.json': app({}), 'README.md': fence('pnpm run build') };
    expect(await brief(files)).toEqual([
      'npm-script README.md:2 npm script `build` (package `app`) does not exist at this commit',
    ]);
  });

  it.each([
    ['bare pnpm (may run a dependency bin)', 'pnpm build'],
    ['bare yarn (may run a bin)', 'yarn build'],
    ['yarn run (may run a bin)', 'yarn run build'],
    ['bun run (may run a file or bin)', 'bun run build'],
    ['an implicit npm script', 'npm test'],
    ['npm start (runs server.js without a script)', 'npm start'],
    ['--if-present', 'npm run build --if-present'],
  ])('does not flag %s', async (_label, command) => {
    const files = { 'package.json': app({}), 'README.md': fence(command) };
    expect(await brief(files)).toEqual([]);
  });

  it('reads only the command around an inline `npm start`, not the prose before it', async () => {
    const files = {
      'package.json': app({}),
      'README.md':
        'Written as `npm run <script>` or `pnpm run <script>` that it defines. `npm start`, `pnpm <script>`, `yarn` are skipped: `npm start` runs a file.',
    };
    expect(await brief(files)).toEqual([]);
  });

  it('still flags an explicit inline `npm run x` after other inline code', async () => {
    const files = { 'package.json': app({}), 'README.md': 'Use `npm install` then `npm run build`, or `pnpm run lint`.' };
    expect(await brief(files)).toEqual([
      'npm-script README.md:1 npm script `build` (package `app`) does not exist at this commit',
      'npm-script README.md:1 npm script `lint` (package `app`) does not exist at this commit',
    ]);
  });

  it('warns about an invalid package.json (a scan has no diff: every file counts) but not about fixtures', async () => {
    const result = await scan({
      'package.json': '{ nope',
      'test/fixtures/a/package.json': '{ nope',
      'README.md': fence('npm run build'),
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^package\.json: invalid package\.json/);
  });

  it('does not read the makefiles and packages of a fixture directory', async () => {
    const files: Files = {
      'Makefile': 'verify:\n',
      'test/fixtures/a/Makefile': 'build:\n',
      'README.md': fence('make build'),
    };
    expect(await brief(files)).toEqual(['make-target README.md:2 Make target `build` does not exist at this commit']);
  });

  it('does not flag anything without a package.json', async () => {
    expect(await brief({ 'README.md': fence('npm run build') })).toEqual([]);
  });

  it('resolves the package of a `cd` or workspace context', async () => {
    const files: Files = {
      'package.json': app({ build: 'x' }),
      'packages/a/package.json': pkg({ name: '@acme/a', scripts: { test: 'vitest' } }),
      'README.md': fence('cd packages/a && npm run build', 'npm run test -w @acme/a', 'npm run build -w @acme/a'),
    };
    expect(await brief(files)).toEqual([
      'npm-script README.md:2 npm script `build` (package `@acme/a`) does not exist at this commit',
      'npm-script README.md:4 npm script `build` (package `@acme/a`) does not exist at this commit',
    ]);
  });

  it('does not flag a workspace it cannot find', async () => {
    const files = { 'package.json': app({}), 'README.md': fence('npm run build -w nope') };
    expect(await brief(files)).toEqual([]);
  });

  it('does not flag when the package.json does not parse, and warns', async () => {
    const files = { 'package.json': '{ nope', 'README.md': fence('npm run build') };
    const result = await scan(files);
    expect(result.findings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^package\.json: invalid package\.json/);
  });
});

describe('scanSnapshot: make targets', () => {
  const makefile = 'build:\n\tcc main.c\n\ntest: build\n\t./run\n';

  it('flags a target that no makefile of the repository defines', async () => {
    const files = { Makefile: makefile, 'README.md': fence('make deploy') };
    expect(await brief(files)).toEqual(['make-target README.md:2 Make target `deploy` does not exist at this commit']);
  });

  it('does not flag a target a makefile defines', async () => {
    expect(await brief({ Makefile: makefile, 'README.md': fence('make build', 'make test') })).toEqual([]);
  });

  it('does not flag anything when there is no makefile', async () => {
    expect(await brief({ 'README.md': fence('make deploy') })).toEqual([]);
  });

  it('accepts a target defined in any makefile, including *.mk', async () => {
    const files = { Makefile: makefile, 'mk/deploy.mk': 'deploy:\n\ttrue\n', 'README.md': fence('make deploy') };
    expect(await brief(files)).toEqual([]);
  });

  it('limits the scope to `make -C <dir>`', async () => {
    const files: Files = {
      Makefile: makefile,
      'sub/Makefile': 'other:\n\ttrue\n',
      'README.md': fence('make -C sub build'),
    };
    expect(await brief(files)).toEqual(['make-target README.md:2 Make target `build` does not exist at this commit']);
  });

  it('does not flag a target that is a file make could build', async () => {
    const files = { Makefile: makefile, 'prog.c': '', 'README.md': fence('make prog') };
    expect(await brief(files)).toEqual([]);
  });

  it('does not flag a file-like target a pattern rule could build', async () => {
    const files = { Makefile: '%.o: %.c\n\tcc -c $<\n', 'README.md': fence('make main.o') };
    expect(await brief(files)).toEqual([]);
  });

  it('does not flag when a makefile includes a file this scan cannot read', async () => {
    const files = { Makefile: `include rules.inc\n${makefile}`, 'rules.inc': 'deploy:\n\ttrue\n', 'README.md': fence('make deploy') };
    expect(await brief(files)).toEqual([]);
  });

  it('keeps flagging when the include is another makefile it reads', async () => {
    const files = { Makefile: `include extra.mk\n${makefile}`, 'extra.mk': 'x:\n\ttrue\n', 'README.md': fence('make deploy') };
    expect(await brief(files)).toEqual(['make-target README.md:2 Make target `deploy` does not exist at this commit']);
  });
});

describe('scanSnapshot: what it never reports', () => {
  const docs = [
    'Set `API_KEY` before starting.',
    fence('export DATABASE_URL=postgres://x', 'echo "$API_KEY"', 'drift-ci --help', 'curl https://example.com'),
  ].join('\n');

  it('never reports environment variables', async () => {
    expect(await brief({ 'README.md': docs, '.env.example': 'OTHER_VAR=1\n' })).toEqual([]);
  });

  it('never reports commands (bins)', async () => {
    expect(await brief({ 'package.json': pkg({ name: 'x', bin: { other: 'cli.js' } }), 'README.md': docs })).toEqual([]);
  });

  it('skips rules without a scan method, whichever rules it is given', async () => {
    expect(envRule()).not.toHaveProperty('scan');
    expect(binRule()).not.toHaveProperty('scan');
    const result = await scan({ 'README.md': `${docs}\nSee \`src/missing.ts\`.` }, { rules: [envRule(), binRule()] });
    expect(result.findings).toEqual([]);
  });

  it('does not prepare a rule that cannot scan', async () => {
    let prepared = false;
    const rule = { id: 'env', kinds: ['env' as const], prepare: async () => void (prepared = true), check: () => undefined };
    await scan({ 'README.md': docs }, { rules: [rule] });
    expect(prepared).toBe(false);
  });

  it('emits only path, npm-script and make-target findings on a doc that mixes everything', async () => {
    const files: Files = {
      'package.json': pkg({ name: 'app', scripts: {} }),
      Makefile: 'build:\n\ttrue\n',
      'README.md': [docs, fence('npm run gone', 'make gone'), 'Also `src/missing.ts`.'].join('\n'),
    };
    const ruleIds = new Set((await scan(files)).findings.map((f) => f.ruleId));
    expect([...ruleIds].sort()).toEqual(['make-target', 'npm-script', 'path']);
  });
});

describe('scanSnapshot: docs, config and suppression', () => {
  it('checks the docs of the head only, not source files', async () => {
    expect(await brief({ 'src/a.ts': '// see `src/missing.ts`', 'README.md': 'x' })).toEqual([]);
  });

  it('skips docs excluded by default, such as changelogs', async () => {
    expect(await brief({ 'CHANGELOG.md': 'Dropped `src/missing.ts`.' }, { config: defaultConfig() })).toEqual([]);
  });

  it('checks the extra docs the config includes', async () => {
    const config = parseConfig('version: 1\ndocs:\n  include: ["notes/**/*.txt"]\n');
    expect(await brief({ 'notes/a.txt': 'x' }, { config })).toEqual([]);
    expect(await brief({ 'AGENTS.md': 'See `src/missing.ts`.' }, { config })).toHaveLength(1);
  });

  it('honours checks switched off in the config', async () => {
    const files = { 'package.json': pkg({ name: 'app' }), 'README.md': ['`src/missing.ts`', fence('npm run gone')].join('\n') };
    const config = parseConfig('version: 1\nchecks:\n  paths: false\n');
    expect((await scan(files, { config })).findings.map((f) => f.ruleId)).toEqual(['npm-script']);
  });

  it('applies ignore entries', async () => {
    const config = parseConfig('version: 1\nignore:\n  - kind: path\n    name: "src/gen/**"\n');
    const files = { 'README.md': 'Gone: `src/gen/a.ts`, `src/b.ts`.' };
    expect((await scan(files, { config })).findings.map((f) => f.fact)).toEqual(['src/b.ts']);
  });

  it('honours drift-ignore comments and historical wording', async () => {
    const files = {
      'README.md': [
        '<!-- drift-ignore-next-line -->',
        'Old: `src/a.ts`.',
        'Formerly `src/b.ts`.',
        'Current: `src/c.ts`.',
      ].join('\n'),
    };
    expect((await scan(files)).findings.map((f) => f.fact)).toEqual(['src/c.ts']);
  });

  it('sorts findings by file, line and column', async () => {
    const files = { 'docs/b.md': '`src/z.ts`', 'docs/a.md': '`src/y.ts` `src/x.ts`' };
    expect((await scan(files)).findings.map((f) => `${f.file}:${f.col}`)).toEqual(['docs/a.md:2', 'docs/a.md:13', 'docs/b.md:2']);
  });

  it('counts a GitHub URL of the same repository as a path when told the repository', async () => {
    const files = { 'README.md': '[x](https://github.com/acme/demo/blob/main/src/missing.ts)' };
    expect(await brief(files, { repo: { owner: 'acme', name: 'demo' } })).toEqual([
      'path README.md:1 `/src/missing.ts` does not exist at this commit',
    ]);
    expect(await brief(files)).toEqual([]);
  });
});
