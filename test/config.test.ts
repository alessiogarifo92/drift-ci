import { describe, expect, it } from 'vitest';
import {
  CHECK_RULE_IDS,
  CONFIG_PATH,
  ConfigError,
  DEFAULT_EXCLUDES,
  defaultConfig,
  factName,
  isCheckedDoc,
  loadConfig,
  matchesIgnore,
  parseConfig,
  type DriftConfig,
} from '../src/core/config.ts';
import { isIndexedDoc } from '../src/core/indexer.ts';
import { memorySnapshot } from './helpers/memory-snapshot.ts';

const configWith = (parts: Partial<DriftConfig>): DriftConfig => ({ ...defaultConfig(), ...parts });

/** The ConfigError message `parseConfig` throws for `text`. */
function errorOf(text: string, source?: string): string {
  try {
    parseConfig(text, source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('parseConfig did not throw');
}

describe('defaultConfig', () => {
  it('has every check on, nothing ignored, no extra docs and failOn none', () => {
    expect(defaultConfig()).toEqual({
      version: 1,
      docs: { include: [], exclude: [] },
      checks: { paths: true, scripts: true, make: true, bin: true, env: true },
      ignore: [],
      failOn: 'none',
    });
  });

  it('returns a fresh object each time', () => {
    const config = defaultConfig();
    config.docs.include.push('x');
    expect(defaultConfig().docs.include).toEqual([]);
  });
});

describe('CHECK_RULE_IDS', () => {
  it('maps each checks key to its rule id', () => {
    expect(CHECK_RULE_IDS).toEqual({
      paths: 'path',
      scripts: 'npm-script',
      make: 'make-target',
      bin: 'bin',
      env: 'env',
    });
  });
});

describe('parseConfig', () => {
  it('reads a full config', () => {
    const config = parseConfig(`
version: 1
docs:
  include: ["guides/**/*.md", "notes/*.txt"]
  exclude:
    - docs/internal/**
checks:
  paths: true
  scripts: false
  make: true
  bin: false
  env: true
ignore:
  - kind: env
    name: LEGACY_*
  - file: docs/old/**
  - kind: path
    name: src/gen.ts
    file: README.md
failOn: warning
`);
    expect(config).toEqual({
      version: 1,
      docs: { include: ['guides/**/*.md', 'notes/*.txt'], exclude: ['docs/internal/**'] },
      checks: { paths: true, scripts: false, make: true, bin: false, env: true },
      ignore: [
        { kind: 'env', name: 'LEGACY_*' },
        { file: 'docs/old/**' },
        { kind: 'path', name: 'src/gen.ts', file: 'README.md' },
      ],
      failOn: 'warning',
    });
  });

  it('fills defaults for a minimal config', () => {
    expect(parseConfig('version: 1\n')).toEqual(defaultConfig());
  });

  it('fills defaults for omitted keys inside docs and checks', () => {
    const config = parseConfig('version: 1\ndocs:\n  include: [a/**]\nchecks:\n  env: false\n');
    expect(config.docs).toEqual({ include: ['a/**'], exclude: [] });
    expect(config.checks).toEqual({ paths: true, scripts: true, make: true, bin: true, env: false });
  });

  it('accepts empty docs.include, docs.exclude and ignore lists', () => {
    expect(parseConfig('version: 1\ndocs: {include: [], exclude: []}\nignore: []\n')).toEqual(defaultConfig());
  });

  it.each(['none', 'warning'] as const)('accepts failOn %s', (failOn) => {
    expect(parseConfig(`version: 1\nfailOn: ${failOn}\n`).failOn).toBe(failOn);
  });

  it.each(['path', 'npm-script', 'make-target', 'env', 'bin'])('accepts ignore kind %s', (kind) => {
    expect(parseConfig(`version: 1\nignore:\n  - kind: ${kind}\n`).ignore).toEqual([{ kind }]);
  });

  describe('errors', () => {
    it('names the config file by default and a custom source when given', () => {
      expect(errorOf('version: 2')).toMatch(/^\.drift-ci\.yml: /);
      expect(errorOf('version: 2', 'custom.yml')).toMatch(/^custom\.yml: /);
      expect(CONFIG_PATH).toBe('.drift-ci.yml');
    });

    it('rejects invalid YAML with the line', () => {
      expect(errorOf('version: 1\nchecks: [a\nenv: false\n')).toMatch(/^\.drift-ci\.yml: invalid YAML: .* at line 3, column 1$/);
    });

    it('rejects duplicate keys as invalid YAML', () => {
      expect(errorOf('version: 1\nversion: 1\n')).toBe('.drift-ci.yml: invalid YAML: Map keys must be unique at line 2, column 1');
    });

    it('rejects a second YAML document', () => {
      expect(errorOf('version: 1\n---\nfailOn: none\n')).toMatch(/invalid YAML: .*multiple documents.* at line 2/);
    });

    it('treats an empty file as a missing version', () => {
      expect(errorOf('')).toBe('.drift-ci.yml: version is required (must be 1)');
      expect(errorOf('# only a comment\n')).toBe('.drift-ci.yml: version is required (must be 1)');
    });

    it.each([['- a\n- b\n'], ['just text'], ['42'], ['[]']])('rejects %j as not a mapping', (text) => {
      expect(errorOf(text)).toBe('.drift-ci.yml: must be a mapping');
    });

    it('rejects a missing version', () => {
      expect(errorOf('failOn: none\n')).toBe('.drift-ci.yml: version is required (must be 1)');
    });

    it.each([['2'], ['"1"'], ['1.5'], ['null'], ['true'], ['[1]']])('rejects version %s', (value) => {
      expect(errorOf(`version: ${value}\n`)).toMatch(/^\.drift-ci\.yml: version must be 1, got /);
    });

    it('names the offending version value', () => {
      expect(errorOf('version: 2\n')).toBe('.drift-ci.yml: version must be 1, got 2');
      expect(errorOf('version: "1"\n')).toBe('.drift-ci.yml: version must be 1, got "1"');
    });

    it('rejects an unknown top-level key and lists the known ones', () => {
      expect(errorOf('version: 1\nfailon: none\n')).toBe(
        '.drift-ci.yml: unknown key "failon" (expected one of: version, docs, checks, ignore, failOn)',
      );
    });

    it('rejects unknown keys inside docs and checks', () => {
      expect(errorOf('version: 1\ndocs:\n  foo: []\n')).toBe(
        '.drift-ci.yml: unknown key "docs.foo" (expected one of: include, exclude)',
      );
      expect(errorOf('version: 1\nchecks:\n  foo: true\n')).toBe(
        '.drift-ci.yml: unknown key "checks.foo" (expected one of: paths, scripts, make, bin, env)',
      );
    });

    it('rejects an unknown key inside an ignore entry', () => {
      expect(errorOf('version: 1\nignore:\n  - kind: env\n    rule: x\n')).toBe(
        '.drift-ci.yml: unknown key "ignore[0].rule" (expected one of: kind, name, file)',
      );
    });

    it.each([['docs'], ['checks']])('rejects a %s that is not a mapping', (key) => {
      expect(errorOf(`version: 1\n${key}: [a]\n`)).toBe(`.drift-ci.yml: ${key} must be a mapping`);
      expect(errorOf(`version: 1\n${key}:\n`)).toBe(`.drift-ci.yml: ${key} must be a mapping`);
    });

    it.each([['include'], ['exclude']])('rejects docs.%s that is not a list of globs', (key) => {
      expect(errorOf(`version: 1\ndocs:\n  ${key}: README.md\n`)).toBe(
        `.drift-ci.yml: docs.${key} must be a list of globs`,
      );
      expect(errorOf(`version: 1\ndocs:\n  ${key}: [a, 3]\n`)).toBe(
        `.drift-ci.yml: docs.${key}[1] must be a non-empty string`,
      );
      expect(errorOf(`version: 1\ndocs:\n  ${key}: ["a", ""]\n`)).toBe(
        `.drift-ci.yml: docs.${key}[1] must be a non-empty string`,
      );
    });

    it.each(['paths', 'scripts', 'make', 'bin', 'env'])('rejects checks.%s that is not a boolean', (key) => {
      expect(errorOf(`version: 1\nchecks:\n  ${key}: "yes"\n`)).toBe(`.drift-ci.yml: checks.${key} must be a boolean`);
      expect(errorOf(`version: 1\nchecks:\n  ${key}: 1\n`)).toBe(`.drift-ci.yml: checks.${key} must be a boolean`);
    });

    it('rejects an ignore that is not a list', () => {
      expect(errorOf('version: 1\nignore: {kind: env}\n')).toBe('.drift-ci.yml: ignore must be a list');
    });

    it('rejects an ignore entry that is not a mapping', () => {
      expect(errorOf('version: 1\nignore:\n  - env\n')).toBe('.drift-ci.yml: ignore[0] must be a mapping');
    });

    it('rejects an empty ignore entry', () => {
      expect(errorOf('version: 1\nignore:\n  - {}\n')).toBe(
        '.drift-ci.yml: ignore[0] needs at least one of kind, name, file',
      );
    });

    it('rejects an unknown ignore kind and lists the valid ones', () => {
      expect(errorOf('version: 1\nignore:\n  - kind: command\n')).toBe(
        '.drift-ci.yml: ignore[0].kind must be one of: path, npm-script, make-target, bin, env',
      );
      expect(errorOf('version: 1\nignore:\n  - kind: 3\n')).toMatch(/ignore\[0\]\.kind must be one of/);
    });

    it.each([['name'], ['file']])('rejects an ignore %s that is not a non-empty string', (key) => {
      expect(errorOf(`version: 1\nignore:\n  - kind: env\n  - ${key}: 3\n`)).toBe(
        `.drift-ci.yml: ignore[1].${key} must be a non-empty string`,
      );
      expect(errorOf(`version: 1\nignore:\n  - ${key}: ""\n`)).toBe(
        `.drift-ci.yml: ignore[0].${key} must be a non-empty string`,
      );
    });

    it('rejects an unknown failOn value', () => {
      expect(errorOf('version: 1\nfailOn: error\n')).toBe('.drift-ci.yml: failOn must be one of: none, warning');
      expect(errorOf('version: 1\nfailOn: true\n')).toBe('.drift-ci.yml: failOn must be one of: none, warning');
    });

    it('reports a non-string key by its text', () => {
      expect(errorOf('version: 1\n7: x\n')).toMatch(/unknown key "7"/);
    });
  });
});

describe('loadConfig', () => {
  it('returns the defaults when the head has no config file', async () => {
    expect(await loadConfig(memorySnapshot({ 'README.md': 'x' }))).toEqual(defaultConfig());
  });

  it('parses .drift-ci.yml from the head snapshot', async () => {
    const head = memorySnapshot({ '.drift-ci.yml': 'version: 1\nfailOn: warning\n' });
    expect((await loadConfig(head)).failOn).toBe('warning');
  });

  it('throws a ConfigError naming the file when it is invalid', async () => {
    const head = memorySnapshot({ '.drift-ci.yml': 'version: 3\n' });
    await expect(loadConfig(head)).rejects.toThrow('.drift-ci.yml: version must be 1, got 3');
  });

  it('only looks at the repository root', async () => {
    const head = memorySnapshot({ 'docs/.drift-ci.yml': 'version: 3\n' });
    expect(await loadConfig(head)).toEqual(defaultConfig());
  });
});

describe('isCheckedDoc', () => {
  const config = defaultConfig();

  it.each([
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/guide.md',
    'packages/a/README.md',
    '.github/copilot-instructions.md',
    '.cursor/rules/style.mdc',
    '.cursorrules',
  ])('checks the built-in doc %s', (path) => {
    expect(isCheckedDoc(path, config)).toBe(true);
  });

  it.each(['src/index.ts', 'notes.txt', 'guides/start.md', 'package.json'])('does not check %s by default', (path) => {
    expect(isCheckedDoc(path, config)).toBe(false);
  });

  it('agrees with isIndexedDoc for docs the default excludes do not touch', () => {
    for (const path of ['README.md', 'docs/a/b.md', 'src/a.ts', 'CLAUDE.md', 'docs/x.txt']) {
      expect(isCheckedDoc(path, config)).toBe(isIndexedDoc(path));
    }
  });

  describe('default excludes', () => {
    it.each([
      'docs/CHANGELOG.md',
      'packages/a/docs/CHANGELOG.md',
      'docs/CHANGES.md',
      'docs/HISTORY.md',
      'docs/RELEASE_NOTES.md',
      'docs/RELEASE.md',
      'docs/adr/0001-use-x.md',
      'docs/adrs/0001-use-x.md',
      'docs/archive/old.md',
      'docs/archived/old.md',
      'docs/MIGRATION.md',
      'docs/migrations/v2.md',
      'docs/migration/v2.md',
      'docs/migration-guide.md',
      'docs/v2-migration-guide.md',
      'docs/upgrading.md',
      'docs/Upgrading-to-v3.md',
      'docs/node_modules/pkg/README.md',
      'docs/vendor/lib/README.md',
      'docs/third_party/lib/README.md',
      'docs/third-party/lib/README.md',
      'docs/guide/adr/x.md',
    ])('excludes %s', (path) => {
      expect(isCheckedDoc(path, config)).toBe(false);
    });

    it.each([
      'node_modules/pkg/README.md',
      'vendor/lib/README.md',
      'third_party/x/README.md',
      'packages/a/node_modules/b/README.md',
      'archive/README.md',
      'adr/README.md',
    ])('excludes README %s at any depth', (path) => {
      expect(isCheckedDoc(path, config)).toBe(false);
    });

    it('excludes a root CHANGELOG even when docs.include names it', () => {
      expect(isCheckedDoc('CHANGELOG.md', configWith({ docs: { include: ['*.md'], exclude: [] } }))).toBe(false);
    });

    it.each(['docs/changelog.md', 'docs/Changelog.md', 'docs/ADR/0001.md', 'docs/Archive/x.md', 'docs/MIGRATION-GUIDE.md', 'docs/UPGRADING.md', 'NODE_MODULES/a/README.md'])(
      'matches case-insensitively: %s',
      (path) => {
        expect(isCheckedDoc(path, config)).toBe(false);
      },
    );

    it('does not exclude look-alike names', () => {
      expect(isCheckedDoc('docs/adr-style.md', config)).toBe(true);
      expect(isCheckedDoc('docs/guide/archives.md', config)).toBe(true);
      expect(isCheckedDoc('docs/vendors.md', config)).toBe(true);
      expect(isCheckedDoc('docs/a-changelog.md', config)).toBe(true);
    });

    it('is a documented list of globs', () => {
      expect(DEFAULT_EXCLUDES).toContain('**/CHANGELOG*');
      expect(DEFAULT_EXCLUDES.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('docs.include', () => {
    it('adds docs to the built-in set', () => {
      const withInclude = configWith({ docs: { include: ['guides/**/*.md', 'notes/*.txt'], exclude: [] } });
      expect(isCheckedDoc('guides/start.md', withInclude)).toBe(true);
      expect(isCheckedDoc('guides/deep/er/start.md', withInclude)).toBe(true);
      expect(isCheckedDoc('notes/a.txt', withInclude)).toBe(true);
      expect(isCheckedDoc('notes/sub/a.txt', withInclude)).toBe(false);
      expect(isCheckedDoc('README.md', withInclude)).toBe(true);
    });

    it('matches dotfiles and dot directories', () => {
      const withInclude = configWith({ docs: { include: ['**/*.md'], exclude: [] } });
      expect(isCheckedDoc('.hidden/notes.md', withInclude)).toBe(true);
      expect(isCheckedDoc('.notes.md', withInclude)).toBe(true);
    });

    it('is case-sensitive', () => {
      expect(isCheckedDoc('Guides/a.md', configWith({ docs: { include: ['guides/*.md'], exclude: [] } }))).toBe(false);
    });
  });

  describe('docs.exclude', () => {
    const withExclude = configWith({ docs: { include: [], exclude: ['docs/internal/**', '**/draft-*.md'] } });

    it('removes built-in docs', () => {
      expect(isCheckedDoc('docs/internal/a.md', withExclude)).toBe(false);
      expect(isCheckedDoc('docs/internal/deep/a.md', withExclude)).toBe(false);
      expect(isCheckedDoc('docs/draft-x.md', withExclude)).toBe(false);
      expect(isCheckedDoc('docs/public/a.md', withExclude)).toBe(true);
    });

    it('wins over docs.include', () => {
      const both = configWith({ docs: { include: ['guides/**/*.md'], exclude: ['guides/private/**'] } });
      expect(isCheckedDoc('guides/a.md', both)).toBe(true);
      expect(isCheckedDoc('guides/private/a.md', both)).toBe(false);
    });

    it('is case-sensitive, unlike the defaults', () => {
      expect(isCheckedDoc('docs/Internal/a.md', withExclude)).toBe(true);
    });
  });

  it('reuses compiled globs for the same config object', () => {
    const cfg = configWith({ docs: { include: ['guides/*.md'], exclude: [] } });
    expect(isCheckedDoc('guides/a.md', cfg)).toBe(true);
    expect(isCheckedDoc('guides/a.md', cfg)).toBe(true);
    expect(isCheckedDoc('guides/b.txt', cfg)).toBe(false);
  });
});

describe('factName', () => {
  it.each([
    ['env', 'env:API_KEY', 'API_KEY'],
    ['make-target', 'make:build', 'build'],
    ['bin', 'bin:drift', 'drift'],
    ['npm-script', 'package.json#build', 'build'],
    ['npm-script', 'packages/a/package.json#build:ci', 'build:ci'],
    ['npm-script', 'build', 'build'],
    ['path', 'src/old.ts', 'src/old.ts'],
    ['path', '/src/old.ts', '/src/old.ts'],
    ['env', 'API_KEY', 'API_KEY'],
  ])('%s fact %s is named %s', (ruleId, fact, name) => {
    expect(factName(ruleId, fact)).toBe(name);
  });
});

describe('matchesIgnore', () => {
  const finding = { ruleId: 'env', fact: 'env:LEGACY_KEY', file: 'docs/guide/setup.md' };

  it('matches on kind', () => {
    expect(matchesIgnore({ kind: 'env' }, finding)).toBe(true);
    expect(matchesIgnore({ kind: 'path' }, finding)).toBe(false);
  });

  it('matches name exactly against the fact without its prefix', () => {
    expect(matchesIgnore({ name: 'LEGACY_KEY' }, finding)).toBe(true);
    expect(matchesIgnore({ name: 'env:LEGACY_KEY' }, finding)).toBe(false);
    expect(matchesIgnore({ name: 'LEGACY' }, finding)).toBe(false);
  });

  it('treats a name with * or ? as a glob', () => {
    expect(matchesIgnore({ name: 'LEGACY_*' }, finding)).toBe(true);
    expect(matchesIgnore({ name: 'LEGACY_K?Y' }, finding)).toBe(true);
    expect(matchesIgnore({ name: 'OTHER_*' }, finding)).toBe(false);
  });

  it('globs path facts with * inside one segment and ** across segments', () => {
    const path = { ruleId: 'path', fact: 'src/gen/a.ts', file: 'README.md' };
    expect(matchesIgnore({ name: 'src/gen/*.ts' }, path)).toBe(true);
    expect(matchesIgnore({ name: 'src/*.ts' }, path)).toBe(false);
    expect(matchesIgnore({ name: 'src/**' }, path)).toBe(true);
  });

  it('matches file as a glob on the doc path, dot directories included', () => {
    expect(matchesIgnore({ file: 'docs/**' }, finding)).toBe(true);
    expect(matchesIgnore({ file: 'docs/guide/setup.md' }, finding)).toBe(true);
    expect(matchesIgnore({ file: 'docs/*.md' }, finding)).toBe(false);
    expect(matchesIgnore({ file: '.github/*' }, { ...finding, file: '.github/copilot-instructions.md' })).toBe(true);
  });

  it('needs every given key to match', () => {
    expect(matchesIgnore({ kind: 'env', name: 'LEGACY_*', file: 'docs/**' }, finding)).toBe(true);
    expect(matchesIgnore({ kind: 'env', name: 'LEGACY_*', file: 'README.md' }, finding)).toBe(false);
    expect(matchesIgnore({ kind: 'bin', name: 'LEGACY_*' }, finding)).toBe(false);
  });
});
