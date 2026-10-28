import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/check.ts';
import { defaultConfig, loadConfig, parseConfig, type DriftConfig } from '../src/core/config.ts';
import type { Reference } from '../src/core/reference.ts';
import type { Drift, Rule } from '../src/core/rules.ts';
import { changeSet, memorySnapshot } from './helpers/memory-snapshot.ts';

/** Reports every reference of kind `path` whose name is in `drifted`, as rule `id`, with `prefix` before the fact. */
function stubRule(id: string, drifted: readonly string[], prefix = ''): Rule & { prepared: number } {
  const rule = {
    id,
    kinds: ['path'] as Rule['kinds'],
    prepared: 0,
    async prepare() {
      rule.prepared++;
    },
    check(ref: Reference): Drift | undefined {
      return drifted.includes(ref.normalized)
        ? { fact: `${prefix}${ref.normalized}`, message: `${ref.normalized} drifted` }
        : undefined;
    },
  };
  return rule;
}

const OLD = 'src/old.ts';
const config = (text = 'version: 1\n'): DriftConfig => parseConfig(text);

async function findingsFor(files: Record<string, string>, options: { config?: DriftConfig; rules?: Rule[] } = {}) {
  const { findings } = await runCheck(memorySnapshot({}), memorySnapshot(files), changeSet(), {
    rules: options.rules ?? [stubRule('path', [OLD])],
    ...(options.config ? { config: options.config } : {}),
  });
  return findings.map((f) => `${f.file}:${f.line}`);
}

describe('runCheck: inline suppression (always on, with or without a config)', () => {
  const withComment = (comment: string, body = `\`${OLD}\``) => ({ 'README.md': `${comment}\n${body}\n\`${OLD}\`` });

  it.each([[undefined], [defaultConfig()]])('drift-ignore-next-line suppresses the next line only (config %#)', async (cfg) => {
    const options = cfg ? { config: cfg } : {};
    expect(await findingsFor(withComment('<!-- drift-ignore-next-line -->'), options)).toEqual(['README.md:3']);
  });

  it('drift-ignore-next-line skips blank lines', async () => {
    expect(await findingsFor({ 'README.md': `<!-- drift-ignore-next-line -->\n\n\`${OLD}\`\n\`${OLD}\`` })).toEqual(['README.md:4']);
  });

  it('drift-ignore-start/end suppress the lines between them', async () => {
    const readme = `\`${OLD}\`\n<!-- drift-ignore-start -->\n\`${OLD}\`\n\`${OLD}\`\n<!-- drift-ignore-end -->\n\`${OLD}\``;
    expect(await findingsFor({ 'README.md': readme })).toEqual(['README.md:1', 'README.md:6']);
  });

  it('an unterminated drift-ignore-start suppresses to the end of the doc', async () => {
    const readme = `\`${OLD}\`\n<!-- drift-ignore-start -->\n\`${OLD}\`\n\`${OLD}\``;
    expect(await findingsFor({ 'README.md': readme })).toEqual(['README.md:1']);
  });

  it('comments of one doc do not leak into another', async () => {
    const files = { 'README.md': `<!-- drift-ignore-start -->\n\`${OLD}\``, 'docs/a.md': `\`${OLD}\`` };
    expect(await findingsFor(files)).toEqual(['docs/a.md:1']);
  });

  it('line numbers survive CRLF line endings', async () => {
    const readme = `<!-- drift-ignore-next-line -->\r\n\`${OLD}\`\r\n\`${OLD}\`\r\n`;
    expect(await findingsFor({ 'README.md': readme })).toEqual(['README.md:3']);
  });

  it('the bare words without the comment markers are not a directive', async () => {
    expect(await findingsFor({ 'README.md': `drift-ignore-next-line\n\`${OLD}\`` })).toEqual(['README.md:2']);
  });
});

describe('runCheck: historical context (always on)', () => {
  it.each([
    'This was renamed from `src/old.ts`.',
    'Formerly `src/old.ts`.',
    '`src/old.ts` is deprecated.',
    '`src/old.ts` was removed in v2.',
    'Previously `src/old.ts`.',
    'PREVIOUSLY `src/old.ts`',
  ])('drops a finding on the line %j', async (line) => {
    expect(await findingsFor({ 'README.md': line })).toEqual([]);
    expect(await findingsFor({ 'README.md': line }, { config: defaultConfig() })).toEqual([]);
  });

  it.each([
    'It moved from `src/old.ts` to `lib/new.ts`.',
    '`src/old.ts` was renamed to `lib/new.ts`.',
    '`src/old.ts` was removed; use `make deploy`.',
    '`src/old.ts` has been replaced by `lib/new.ts`.',
    '`src/old.ts` is gone, it is no longer used.',
    '`src/old.ts` used to be the entry point.',
    '`src/old.ts` now lives in `lib/`.',
  ])('drops a finding on the same-PR wording %j', async (line) => {
    expect(await findingsFor({ 'README.md': line })).toEqual([]);
  });

  it('still flags a plain line with the old name only', async () => {
    expect(await findingsFor({ 'README.md': 'The entry point is `src/old.ts`, it starts the app.' })).toEqual([
      'README.md:1',
    ]);
  });

  it('only looks at the line of the reference', async () => {
    expect(await findingsFor({ 'README.md': `Formerly something.\n\`${OLD}\`` })).toEqual(['README.md:2']);
  });
});

describe('runCheck: the author already wrote the new name', () => {
  const suggesting = (): Rule => ({
    id: 'path',
    kinds: ['path'],
    prepare: async () => undefined,
    check: (ref) => (ref.normalized === OLD ? { fact: OLD, message: 'moved', suggestion: 'lib/new.ts' } : undefined),
  });

  it('drops a finding whose line already contains its suggestion', async () => {
    const files = { 'README.md': 'Entry: `lib/new.ts`, also see `src/old.ts`.\nTry `src/old.ts` here.' };
    expect(await findingsFor(files, { rules: [suggesting()] })).toEqual(['README.md:2']);
  });

  it('keeps a finding without a suggestion on a line that names other files', async () => {
    const files = { 'README.md': 'Entry: `lib/new.ts`, also see `src/old.ts`.' };
    expect(await findingsFor(files)).toEqual(['README.md:1']);
  });
});

describe('runCheck: docs filter from the config', () => {
  const stub = () => [stubRule('path', [OLD])];

  it('never reports a CHANGELOG.md reference by default', async () => {
    const files = {
      'README.md': `\`${OLD}\``,
      'docs/CHANGELOG.md': `\`${OLD}\``,
      'docs/HISTORY.md': `\`${OLD}\``,
      'docs/adr/0001.md': `\`${OLD}\``,
      'docs/migration-guide.md': `\`${OLD}\``,
    };
    expect(await findingsFor(files, { config: defaultConfig(), rules: stub() })).toEqual(['README.md:1']);
  });

  it('includes extra docs from docs.include', async () => {
    const files = { 'README.md': `\`${OLD}\``, 'guides/a.md': `\`${OLD}\``, 'notes.txt': `\`${OLD}\`` };
    const cfg = config('version: 1\ndocs:\n  include: ["guides/**/*.md"]\n');
    expect(await findingsFor(files, { config: cfg })).toEqual(['README.md:1', 'guides/a.md:1']);
  });

  it('drops docs from docs.exclude, and exclude wins over include', async () => {
    const files = { 'README.md': `\`${OLD}\``, 'docs/internal/a.md': `\`${OLD}\``, 'guides/b.md': `\`${OLD}\`` };
    const cfg = config('version: 1\ndocs:\n  include: ["guides/**"]\n  exclude: ["docs/internal/**", "guides/**"]\n');
    expect(await findingsFor(files, { config: cfg })).toEqual(['README.md:1']);
  });

  it('without a config the built-in docs apply and a changelog under docs/ is still read', async () => {
    const files = { 'docs/CHANGELOG.md': `\`${OLD}\`` };
    expect(await findingsFor(files)).toEqual(['docs/CHANGELOG.md:1']);
  });

  it('an explicit docFilter wins over the config', async () => {
    const files = { 'README.md': `\`${OLD}\``, 'notes.txt': `\`${OLD}\`` };
    const { findings } = await runCheck(memorySnapshot({}), memorySnapshot(files), changeSet(), {
      rules: stub(),
      config: defaultConfig(),
      docFilter: (path) => path === 'notes.txt',
    });
    expect(findings.map((f) => f.file)).toEqual(['notes.txt']);
  });
});

describe('runCheck: checks toggles', () => {
  const rules = () => [
    stubRule('path', [OLD]),
    stubRule('npm-script', [OLD]),
    stubRule('make-target', [OLD]),
    stubRule('bin', [OLD]),
    stubRule('env', [OLD]),
    stubRule('custom', [OLD]),
  ];
  const files = { 'README.md': `\`${OLD}\`` };

  async function ruleIds(text: string): Promise<{ ids: string[]; prepared: number[] }> {
    const list = rules();
    const { findings } = await runCheck(memorySnapshot({}), memorySnapshot(files), changeSet(), {
      rules: list,
      config: config(text),
    });
    return { ids: findings.map((f) => f.ruleId), prepared: list.map((r) => (r as Rule & { prepared: number }).prepared) };
  }

  it('runs every rule by default', async () => {
    expect((await ruleIds('version: 1\n')).ids.sort()).toEqual(['bin', 'custom', 'env', 'make-target', 'npm-script', 'path']);
  });

  it.each([
    ['paths', 'path'],
    ['scripts', 'npm-script'],
    ['make', 'make-target'],
    ['bin', 'bin'],
    ['env', 'env'],
  ])('checks.%s: false switches off the %s rule only, before it is prepared', async (key, id) => {
    const { ids, prepared } = await ruleIds(`version: 1\nchecks:\n  ${key}: false\n`);
    expect(ids).not.toContain(id);
    expect(ids).toHaveLength(5);
    expect(prepared.filter((n) => n === 0)).toHaveLength(1);
  });

  it('keeps rules the config does not know about', async () => {
    const { ids } = await ruleIds('version: 1\nchecks: {paths: false, scripts: false, make: false, bin: false, env: false}\n');
    expect(ids).toEqual(['custom']);
  });

  it('is fine with a rule that is not registered yet', async () => {
    const { findings } = await runCheck(memorySnapshot({}), memorySnapshot(files), changeSet(), {
      rules: [stubRule('path', [OLD])],
      config: config('version: 1\nchecks:\n  env: false\n  bin: false\n'),
    });
    expect(findings).toHaveLength(1);
  });
});

describe('runCheck: ignore entries', () => {
  const files = { 'README.md': `\`${OLD}\``, 'docs/guide.md': `\`${OLD}\` and \`src/keep.ts\`` };
  const rules = () => [stubRule('path', [OLD, 'src/keep.ts'])];
  const ignoring = (entries: string) => config(`version: 1\nignore:\n${entries}`);
  const run = (cfg: DriftConfig) => findingsFor(files, { config: cfg, rules: rules() });

  it('with no entries reports everything', async () => {
    expect(await run(config())).toEqual(['README.md:1', 'docs/guide.md:1', 'docs/guide.md:1']);
  });

  it('ignores by kind', async () => {
    expect(await run(ignoring('  - kind: path\n'))).toEqual([]);
    expect(await run(ignoring('  - kind: env\n'))).toHaveLength(3);
  });

  it('ignores by exact name', async () => {
    expect(await run(ignoring('  - name: src/old.ts\n'))).toEqual(['docs/guide.md:1']);
  });

  it('ignores by name glob', async () => {
    expect(await run(ignoring('  - name: "src/o*.ts"\n'))).toEqual(['docs/guide.md:1']);
    expect(await run(ignoring('  - name: "src/*.ts"\n'))).toEqual([]);
  });

  it('ignores by file glob', async () => {
    expect(await run(ignoring('  - file: docs/**\n'))).toEqual(['README.md:1']);
    expect(await run(ignoring('  - file: README.md\n'))).toEqual(['docs/guide.md:1', 'docs/guide.md:1']);
  });

  it('needs all keys of one entry to match', async () => {
    expect(await run(ignoring('  - kind: path\n    name: src/old.ts\n    file: docs/**\n'))).toEqual(['README.md:1', 'docs/guide.md:1']);
    expect(await run(ignoring('  - kind: env\n    name: src/old.ts\n'))).toHaveLength(3);
  });

  it('any entry may match', async () => {
    expect(await run(ignoring('  - file: README.md\n  - name: src/keep.ts\n'))).toEqual(['docs/guide.md:1']);
  });

  it('strips the rule prefix from the fact before matching name', async () => {
    const prefixed = [stubRule('env', [OLD], 'env:')];
    const cfg = ignoring('  - name: src/old.ts\n');
    expect(await findingsFor(files, { config: cfg, rules: prefixed })).toEqual([]);
    const other = [stubRule('npm-script', [OLD], 'package.json#')];
    expect(await findingsFor(files, { config: cfg, rules: other })).toEqual([]);
  });
});

describe('runCheck: result', () => {
  it('surfaces failOn from the config', async () => {
    const run = (cfg?: DriftConfig) =>
      runCheck(memorySnapshot({}), memorySnapshot({}), changeSet(), { rules: [], ...(cfg ? { config: cfg } : {}) });
    expect((await run(config('version: 1\nfailOn: warning\n'))).failOn).toBe('warning');
    expect((await run(config())).failOn).toBe('none');
    expect((await run()).failOn).toBe('none');
  });

  it('keeps schemaVersion 1', async () => {
    expect((await runCheck(memorySnapshot({}), memorySnapshot({}), changeSet(), { rules: [] })).schemaVersion).toBe(1);
  });

  it('reads the config from the head snapshot, not the base', async () => {
    const base = memorySnapshot({ '.drift-ci.yml': 'version: 1\nfailOn: none\nignore:\n  - kind: path\n' });
    const head = memorySnapshot({ '.drift-ci.yml': 'version: 1\nfailOn: warning\n', 'README.md': `\`${OLD}\`` });
    const cfg = await loadConfig(head);
    const result = await runCheck(base, head, changeSet(), { rules: [stubRule('path', [OLD])], config: cfg });
    expect(result.failOn).toBe('warning');
    expect(result.findings).toHaveLength(1);
    expect(await loadConfig(base)).not.toEqual(cfg);
  });
});
