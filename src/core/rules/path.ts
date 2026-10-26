// Path rule: a path reference in a head doc has drifted when it resolved to
// something in base and resolves to nothing in head (docs/decisions.md, phase 3).
import { posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { Reference } from '../reference.ts';
import type { CheckContext, Drift, Rule } from '../rules.ts';
import type { ChangeSet, SnapshotEntry } from '../snapshot.ts';

/** A removed path under one of these directories is a build product, not documentation drift. */
const BUILD_DIRS: ReadonlySet<string> = new Set(['dist', 'build', 'out', '.next', 'coverage']);

/** What one commit contains, as a path set: files, their ancestor directories and submodules. */
interface Inventory {
  /** Every non-directory entry: files, symlinks and submodule gitlinks. */
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
  submodules: ReadonlySet<string>;
}

/** One place a reference may point to, and the directory (`''` = repo root) it was resolved from. */
interface Candidate {
  path: string;
  origin: string;
}

interface State {
  base: Inventory;
  head: Inventory;
  renamed: ReadonlyMap<string, string>;
  /** Longest source directory first, so the nearest renamed directory wins. */
  renamedDirs: readonly { from: string; to: string }[];
  isIgnoredInHead: (path: string, isDir: boolean) => boolean;
}

function inventoryOf(entries: readonly SnapshotEntry[]): Inventory {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const submodules = new Set<string>();
  for (const { path, kind } of entries) {
    files.add(path);
    if (kind === 'submodule') submodules.add(path);
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'));
  }
  return { files, dirs, submodules };
}

/** A path exists when it is an entry, a directory with entries under it, or inside a submodule. */
function exists(inv: Inventory, path: string): boolean {
  if (inv.files.has(path) || inv.dirs.has(path)) return true;
  if (inv.submodules.size === 0) return false;
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i++) {
    if (inv.submodules.has(segments.slice(0, i).join('/'))) return true;
  }
  return false;
}

/** Repo-relative form of `path`, or `undefined` when it is the root itself or escapes the repository. */
function clean(path: string): string | undefined {
  const normalized = posix.normalize(path).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

/** Nearest ancestor directory of the doc (its own directory included) that holds a package.json. */
function packageRoot(inv: Inventory, docPath: string): string | undefined {
  let dir = posix.dirname(docPath);
  while (dir !== '.' && dir !== '') {
    if (inv.files.has(`${dir}/package.json`)) return dir;
    dir = posix.dirname(dir);
  }
  return undefined;
}

/** Where a path reference of the doc may point to, in order of preference. */
function candidatesFor(inv: Inventory, docPath: string, normalized: string): Candidate[] {
  const origins: { origin: string; path: string }[] = [];
  if (normalized.startsWith('/')) {
    origins.push({ origin: '', path: normalized.replace(/^\/+/, '') });
  } else {
    const docDir = posix.dirname(docPath);
    origins.push({ origin: docDir === '.' ? '' : docDir, path: posix.join(docDir, normalized) });
    const pkg = packageRoot(inv, docPath);
    if (pkg !== undefined) origins.push({ origin: pkg, path: posix.join(pkg, normalized) });
    origins.push({ origin: '', path: normalized });
  }
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const { origin, path } of origins) {
    const cleaned = clean(path);
    if (cleaned === undefined || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push({ path: cleaned, origin });
  }
  return result;
}

function underBuildDir(path: string): boolean {
  return path.split('/').some((segment) => BUILD_DIRS.has(segment));
}

/** Where git says `path` went: its own rename, else the rename of the nearest renamed directory. */
function movedTo(state: State, path: string): string | undefined {
  const renamed = state.renamed.get(path);
  if (renamed !== undefined) return renamed;
  for (const { from, to } of state.renamedDirs) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  }
  return undefined;
}

/** `newPath` written the way the doc wrote the reference, or `undefined` when its text is not a path. */
function styled(ref: Reference, origin: string, newPath: string): string | undefined {
  const token = ref.contextLine.slice(ref.col - 1);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return undefined; // a URL: the text to replace is not a path
  let text: string;
  if (ref.normalized.startsWith('/')) {
    text = `/${newPath}`;
  } else {
    text = origin === '' ? newPath : posix.relative(origin, newPath);
    if (text === '') return undefined;
    if (token.startsWith('./') && !text.startsWith('../')) text = `./${text}`;
  }
  return ref.normalized.endsWith('/') && !text.endsWith('/') ? `${text}/` : text;
}

/** Rules of every `.gitignore` of the head commit, shallowest directory first. */
async function loadGitignores(ctx: CheckContext): Promise<{ dir: string; rules: Ignore }[]> {
  const paths = ctx.headFiles
    .filter((e) => e.kind === 'file' && posix.basename(e.path) === '.gitignore')
    .map((e) => e.path);
  const contents = await ctx.head.readFiles(paths);
  return paths
    .map((path) => ({
      dir: posix.dirname(path) === '.' ? '' : posix.dirname(path),
      rules: ignore({ ignorecase: false }).add(contents.get(path) ?? ''),
    }))
    .sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || (a.dir < b.dir ? -1 : 1));
}

function ignoreMatcher(gitignores: readonly { dir: string; rules: Ignore }[]): State['isIgnoredInHead'] {
  return (path, isDir) => {
    let ignored = false;
    // Deeper files take precedence over shallower ones, as in git.
    for (const { dir, rules } of gitignores) {
      if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
      const relative = dir === '' ? path : path.slice(dir.length + 1);
      const result = rules.test(isDir ? `${relative}/` : relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  };
}

function describeChange(fact: string, movedTo: string | undefined): string {
  return movedTo === undefined
    ? `\`${fact}\` was removed in this change`
    : `\`${fact}\` was renamed to \`${movedTo}\` in this change`;
}

/**
 * Flags a path reference that resolved in base and resolves to nothing in head. A reference of a doc
 * is looked up doc-relative, then against the nearest package root, then against the repo root
 * (a leading `/` means the repo root only); it is flagged only when the first candidate that
 * existed in base is gone and no candidate exists in head.
 *
 * Removed paths under a build directory or ignored by the head `.gitignore` files are not reported.
 * A factory: the rule keeps its inventories for one run.
 */
export function pathRule(): Rule {
  let state: State | undefined;

  return {
    id: 'path',
    kinds: ['path'],

    async prepare(ctx) {
      const changes: ChangeSet = ctx.changes;
      state = {
        base: inventoryOf(ctx.baseFiles),
        head: inventoryOf(ctx.headFiles),
        renamed: new Map(changes.renamed.map((r) => [r.from, r.to])),
        renamedDirs: [...changes.renamedDirs].sort((a, b) => b.from.length - a.from.length),
        isIgnoredInHead: ignoreMatcher(await loadGitignores(ctx)),
      };
    },

    check(ref, doc): Drift | undefined {
      const s = state;
      if (s === undefined) throw new Error('pathRule: prepare() must run before check()');

      const matched = candidatesFor(s.base, doc.path, ref.normalized).find((c) => exists(s.base, c.path));
      if (matched === undefined) return undefined; // never resolved: a pre-existing broken reference

      const inHead = [
        ...candidatesFor(s.head, doc.path, ref.normalized),
        ...candidatesFor(s.base, doc.path, ref.normalized),
      ];
      if (inHead.some((c) => exists(s.head, c.path))) return undefined;

      if (underBuildDir(matched.path) || s.isIgnoredInHead(matched.path, s.base.dirs.has(matched.path))) {
        return undefined;
      }

      const target = movedTo(s, matched.path);
      const drift: Drift = { fact: matched.path, message: describeChange(matched.path, target) };
      if (target !== undefined) {
        const suggestion = styled(ref, matched.origin, target);
        if (suggestion !== undefined) drift.suggestion = suggestion;
      }
      return drift;
    },
  };
}
