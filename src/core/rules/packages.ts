// Shared by the npm-script and bin rules: every package.json of a commit, parsed
// without throwing, and the lookups a doc reference needs to find its package.
import { posix } from 'node:path';
import type { CheckContext } from '../rules.ts';
import type { RepoSnapshot, SnapshotEntry } from '../snapshot.ts';

export interface PackageInfo {
  /** Repo-relative path of the package.json. */
  path: string;
  /** Repo-relative directory of the package; `''` for the repo root. */
  dir: string;
  name: string | undefined;
  /** Script name -> command, string bodies only. */
  scripts: ReadonlyMap<string, string>;
  /** Bin name -> file it points to. */
  bins: ReadonlyMap<string, string>;
}

/** The packages of one commit, with the lookups a reference needs. */
export interface PackageSet {
  readonly packages: readonly PackageInfo[];
  /** The package whose directory is exactly `dir` (`''` = root). */
  at(dir: string): PackageInfo | undefined;
  /** The package at `dir` or the nearest ancestor directory that has one. */
  nearest(dir: string): PackageInfo | undefined;
  /** The package a `-w` / `--filter` / `yarn workspace` value names: by name, else by directory (suffix). */
  byWorkspace(value: string): PackageInfo | undefined;
}

export interface Packages {
  base: PackageSet;
  head: PackageSet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringEntries(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!isRecord(value)) return result;
  for (const [key, body] of Object.entries(value)) if (typeof body === 'string') result.set(key, body);
  return result;
}

/** Parses one package.json; never throws: an unreadable one is `{ error }` (the reason). */
export function parsePackageJson(path: string, text: string): PackageInfo | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(data)) return { error: 'not a JSON object' };

  const name = typeof data.name === 'string' && data.name !== '' ? data.name : undefined;
  const bins = new Map<string, string>();
  if (typeof data.bin === 'string') {
    if (name !== undefined) bins.set(name.replace(/^@[^/]+\//, ''), data.bin);
  } else {
    for (const [binName, file] of stringEntries(data.bin)) bins.set(binName, file);
  }
  const dir = posix.dirname(path);
  return { path, dir: dir === '.' ? '' : dir, name, scripts: stringEntries(data.scripts), bins };
}

function normalizeWorkspace(value: string): string {
  return posix.normalize(value).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

function packageSet(packages: readonly PackageInfo[]): PackageSet {
  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const at = (dir: string) => byDir.get(dir);
  return {
    packages,
    at,
    nearest(dir) {
      let current = dir === '.' ? '' : dir;
      for (;;) {
        const found = byDir.get(current);
        if (found !== undefined) return found;
        if (current === '') return undefined;
        const parent = posix.dirname(current);
        current = parent === '.' ? '' : parent;
      }
    },
    byWorkspace(value) {
      const wanted = normalizeWorkspace(value);
      if (wanted === '' || wanted === '.' || /[*?{}]/.test(wanted)) return undefined; // empty or a glob
      const byName = packages.filter((p) => p.name === value || p.name === wanted);
      if (byName.length === 1) return byName[0];
      const exact = byDir.get(wanted);
      if (exact !== undefined) return exact;
      const suffix = packages.filter((p) => p.dir.endsWith(`/${wanted}`));
      return suffix.length === 1 ? suffix[0] : undefined;
    },
  };
}

function isPackageJson(entry: SnapshotEntry): boolean {
  return (
    entry.kind === 'file' &&
    posix.basename(entry.path) === 'package.json' &&
    !entry.path.split('/').includes('node_modules')
  );
}

interface Side {
  parsed: Map<string, PackageInfo>;
  invalid: Map<string, string>;
}

async function readSide(snapshot: RepoSnapshot, files: readonly SnapshotEntry[]): Promise<Side> {
  const paths = files.filter(isPackageJson).map((e) => e.path);
  const contents = await snapshot.readFiles(paths);
  const side: Side = { parsed: new Map(), invalid: new Map() };
  for (const path of paths) {
    const result = parsePackageJson(path, contents.get(path) ?? '');
    if ('error' in result) side.invalid.set(path, result.error);
    else side.parsed.set(path, result);
  }
  return side;
}

const cache = new WeakMap<CheckContext, Promise<Packages>>();

/**
 * The packages of base and head. A package.json that cannot be read on either side is warned about and
 * left out of both: comparing it to the other side would report its scripts as removed.
 * Computed once per run and shared by the rules that need it.
 */
export function loadPackages(ctx: CheckContext): Promise<Packages> {
  let loaded = cache.get(ctx);
  if (loaded === undefined) {
    loaded = (async () => {
      const [base, head] = await Promise.all([readSide(ctx.base, ctx.baseFiles), readSide(ctx.head, ctx.headFiles)]);
      const invalid = new Set([...base.invalid.keys(), ...head.invalid.keys()]);
      for (const [path, reason] of [...base.invalid, ...head.invalid]) {
        ctx.warn(`${path}: invalid package.json (${reason}); its scripts and bins are ignored`);
      }
      const usable = (side: Side) => packageSet([...side.parsed.values()].filter((p) => !invalid.has(p.path)));
      return { base: usable(base), head: usable(head) };
    })();
    cache.set(ctx, loaded);
  }
  return loaded;
}

/**
 * The repo-relative directory a reference's `cwd` (relative to the doc's directory) points to; `''` is the
 * repo root. `undefined` when it cannot be placed: absolute, `~`, `$VAR`, or outside the repository.
 */
export function resolveCwdDir(docPath: string, cwd: string): string | undefined {
  if (/^[/~$]/.test(cwd)) return undefined;
  const dir = posix.normalize(posix.join(posix.dirname(docPath), cwd)).replace(/\/+$/, '');
  if (dir === '..' || dir.startsWith('../')) return undefined;
  return dir === '.' ? '' : dir;
}
