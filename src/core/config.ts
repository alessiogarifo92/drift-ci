// `.drift-ci.yml`: what the repository tells drift-ci about itself (docs to check, checks to run,
// findings to ignore). Pure: the text comes from the head snapshot, the schema is validated here.
import picomatch from 'picomatch';
import { parseDocument } from 'yaml';
import type { FailOn, Finding } from './finding.ts';
import { isIndexedDoc } from './indexer.ts';
import type { RepoSnapshot } from './snapshot.ts';

/** Where the config lives: the repository root only. */
export const CONFIG_PATH = '.drift-ci.yml';

/** `checks` key → id of the rule it switches. */
export const CHECK_RULE_IDS = {
  paths: 'path',
  scripts: 'npm-script',
  make: 'make-target',
  bin: 'bin',
  env: 'env',
} as const;

export type CheckKey = keyof typeof CHECK_RULE_IDS;
/** A rule id as `ignore[].kind` names it (`Finding.ruleId`). */
export type RuleId = (typeof CHECK_RULE_IDS)[CheckKey];

const CHECK_KEYS = Object.keys(CHECK_RULE_IDS) as CheckKey[];
const RULE_IDS: readonly string[] = Object.values(CHECK_RULE_IDS);
const FAIL_ON: readonly FailOn[] = ['none', 'warning'];

export interface IgnoreEntry {
  /** Rule id of the finding. */
  kind?: RuleId;
  /** The finding's fact without its rule prefix: an exact string, or a glob when it has `*` or `?`. */
  name?: string;
  /** Glob on the repo-relative path of the doc. */
  file?: string;
}

export interface DriftConfig {
  version: 1;
  docs: {
    /** Globs of extra files to check, added to the built-in set of docs. */
    include: string[];
    /** Globs of docs never to check, added to `DEFAULT_EXCLUDES`; wins over `include`. */
    exclude: string[];
  };
  checks: Record<CheckKey, boolean>;
  ignore: IgnoreEntry[];
  failOn: FailOn;
}

/** A config file that cannot be used. The message names the file and the offending key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Docs that talk about the past or about other people's code, so they are never checked unless
 * a config file's `docs.include` brings them back (and it cannot: excludes win). Matched
 * case-insensitively, at any depth.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  // Changelogs, history and release notes: they name things that no longer exist, on purpose.
  '**/CHANGELOG*',
  '**/CHANGES*',
  '**/HISTORY*',
  '**/RELEASE*',
  // Architecture decision records record decisions as they were.
  '**/adr/**',
  '**/adrs/**',
  // Archived docs are frozen.
  '**/archive/**',
  '**/archived/**',
  // Migration and upgrade guides describe the old names next to the new ones.
  '**/MIGRATION*',
  '**/migration*/**',
  '**/*migration-guide*',
  '**/*upgrading*',
  // Dependencies and vendored code: not this repository's docs.
  '**/node_modules/**',
  '**/vendor/**',
  '**/third_party/**',
  '**/third-party/**',
];

export function defaultConfig(): DriftConfig {
  return {
    version: 1,
    docs: { include: [], exclude: [] },
    checks: { paths: true, scripts: true, make: true, bin: true, env: true },
    ignore: [],
    failOn: 'none',
  };
}

type Plain = Record<string, unknown>;

function isMapping(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The config in `text`, defaults filled in. `source` names the file in error messages.
 * Throws `ConfigError` on invalid YAML, a non-mapping, an unknown key, a missing or wrong
 * `version` (only `1` exists) and a value of the wrong type.
 */
export function parseConfig(text: string, source: string = CONFIG_PATH): DriftConfig {
  const fail = (message: string): never => {
    throw new ConfigError(`${source}: ${message}`);
  };

  const doc = parseDocument(text);
  const [yamlError] = doc.errors;
  if (yamlError) {
    // The library's message continues with a code frame: the first line says what and where.
    const [firstLine = yamlError.message] = yamlError.message.split('\n');
    return fail(`invalid YAML: ${firstLine.replace(/:$/, '')}`);
  }
  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined) return fail('version is required (must be 1)');
  if (!isMapping(raw)) return fail('must be a mapping');

  const checkKeys = (map: Plain, allowed: readonly string[], path: string): void => {
    for (const key of Object.keys(map)) {
      if (!allowed.includes(key)) {
        const name = path === '' ? key : `${path}.${key}`;
        fail(`unknown key "${name}" (expected one of: ${allowed.join(', ')})`);
      }
    }
  };
  const mappingAt = (value: unknown, path: string): Plain => (isMapping(value) ? value : fail(`${path} must be a mapping`));
  const globsAt = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value)) return fail(`${path} must be a list of globs`);
    return value.map((item: unknown, i) =>
      typeof item === 'string' && item !== '' ? item : fail(`${path}[${i}] must be a non-empty string`),
    );
  };

  checkKeys(raw, ['version', 'docs', 'checks', 'ignore', 'failOn'], '');
  if (!('version' in raw)) fail('version is required (must be 1)');
  if (raw.version !== 1) fail(`version must be 1, got ${JSON.stringify(raw.version)}`);

  const config = defaultConfig();

  if ('docs' in raw) {
    const docs = mappingAt(raw.docs, 'docs');
    checkKeys(docs, ['include', 'exclude'], 'docs');
    if ('include' in docs) config.docs.include = globsAt(docs.include, 'docs.include');
    if ('exclude' in docs) config.docs.exclude = globsAt(docs.exclude, 'docs.exclude');
  }

  if ('checks' in raw) {
    const checks = mappingAt(raw.checks, 'checks');
    checkKeys(checks, CHECK_KEYS, 'checks');
    for (const key of CHECK_KEYS) {
      if (!(key in checks)) continue;
      const value = checks[key];
      if (typeof value !== 'boolean') fail(`checks.${key} must be a boolean`);
      config.checks[key] = value as boolean;
    }
  }

  if ('ignore' in raw) {
    if (!Array.isArray(raw.ignore)) fail('ignore must be a list');
    config.ignore = (raw.ignore as unknown[]).map((item, i): IgnoreEntry => {
      const path = `ignore[${i}]`;
      const entry = mappingAt(item, path);
      checkKeys(entry, ['kind', 'name', 'file'], path);
      if (Object.keys(entry).length === 0) fail(`${path} needs at least one of kind, name, file`);
      const out: IgnoreEntry = {};
      if ('kind' in entry) {
        const kind = entry.kind;
        if (typeof kind !== 'string' || !RULE_IDS.includes(kind)) fail(`${path}.kind must be one of: ${RULE_IDS.join(', ')}`);
        out.kind = kind as RuleId;
      }
      for (const key of ['name', 'file'] as const) {
        if (!(key in entry)) continue;
        const value = entry[key];
        if (typeof value !== 'string' || value === '') fail(`${path}.${key} must be a non-empty string`);
        out[key] = value as string;
      }
      return out;
    });
  }

  if ('failOn' in raw) {
    const failOn = raw.failOn;
    if (typeof failOn !== 'string' || !FAIL_ON.includes(failOn as FailOn)) fail(`failOn must be one of: ${FAIL_ON.join(', ')}`);
    config.failOn = failOn as FailOn;
  }

  return config;
}

/** The config of the head commit: `.drift-ci.yml` at its root, or the defaults when there is none. */
export async function loadConfig(head: RepoSnapshot): Promise<DriftConfig> {
  const text = await head.readFile(CONFIG_PATH);
  return text === undefined ? defaultConfig() : parseConfig(text);
}

const globOptions = { dot: true };
const defaultExcluded = picomatch([...DEFAULT_EXCLUDES], { ...globOptions, nocase: true });

interface DocMatchers {
  include: (path: string) => boolean;
  exclude: (path: string) => boolean;
}

const matchers = new WeakMap<DriftConfig, DocMatchers>();

function matchersFor(config: DriftConfig): DocMatchers {
  let found = matchers.get(config);
  if (!found) {
    found = {
      include: config.docs.include.length > 0 ? picomatch(config.docs.include, globOptions) : () => false,
      exclude: config.docs.exclude.length > 0 ? picomatch(config.docs.exclude, globOptions) : () => false,
    };
    matchers.set(config, found);
  }
  return found;
}

/**
 * Whether a repo-relative POSIX path is a doc to check: a built-in doc (`isIndexedDoc`) or one
 * matching `docs.include`, and not matched by `DEFAULT_EXCLUDES` or `docs.exclude`.
 */
export function isCheckedDoc(path: string, config: DriftConfig): boolean {
  const { include, exclude } = matchersFor(config);
  if (!isIndexedDoc(path) && !include(path)) return false;
  return !defaultExcluded(path) && !exclude(path);
}

/** A finding's fact without its rule prefix: `env:X` → `X`, `<pkg>/package.json#build` → `build`, paths as-is. */
export function factName(ruleId: string, fact: string): string {
  switch (ruleId) {
    case 'env':
      return fact.replace(/^env:/, '');
    case 'make-target':
      return fact.replace(/^make:/, '');
    case 'bin':
      return fact.replace(/^bin:/, '');
    case 'npm-script':
      return fact.slice(fact.lastIndexOf('#') + 1);
    default:
      return fact;
  }
}

/** Whether an `ignore` entry matches the finding: every key it gives must match. */
export function matchesIgnore(entry: IgnoreEntry, finding: Pick<Finding, 'ruleId' | 'fact' | 'file'>): boolean {
  if (entry.kind !== undefined && entry.kind !== finding.ruleId) return false;
  if (entry.name !== undefined) {
    const name = factName(finding.ruleId, finding.fact);
    const matches = /[*?]/.test(entry.name) ? picomatch.isMatch(name, entry.name, globOptions) : name === entry.name;
    if (!matches) return false;
  }
  return entry.file === undefined || picomatch.isMatch(finding.file, entry.file, globOptions);
}
