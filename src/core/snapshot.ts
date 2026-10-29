// Contracts between the analysis core and the adapters that read a repository
// (RepoSnapshot, ChangeSet) plus the pure helpers that work on their data.
// Adapters live outside src/core: see src/git for the git-backed ones.

export type EntryKind = "file" | "symlink" | "submodule";

/** One tree entry of a commit. Directories are not listed, only what they contain. */
export interface SnapshotEntry {
  path: string;
  kind: EntryKind;
  /** Git file mode as printed by `git ls-tree`, e.g. `100644`, `120000`, `160000`. */
  mode: string;
  /** Object id of the blob, or of the commit a submodule gitlink points to. */
  oid: string;
}

export interface GrepHit {
  path: string;
  /** 1-indexed. */
  line: number;
  text: string;
}

/** Read-only view of one commit. Never reads a working tree. */
export interface RepoSnapshot {
  /** Full commit SHA the snapshot was resolved to. */
  readonly commit: string;
  /** Every entry of the commit's tree, sorted by path. Cached after the first call. */
  listFiles(): Promise<SnapshotEntry[]>;
  /** UTF-8 content, or `undefined` when the path is absent or is not a blob (directory, submodule). */
  readFile(path: string): Promise<string | undefined>;
  /** Reads many files in one batch; absent or non-blob paths are omitted from the result. */
  readFiles(paths: readonly string[]): Promise<Map<string, string>>;
  /** Whole-word, fixed-string search (`ignoreCase`: case-insensitive). Lines are 1-indexed; no match is `[]`. */
  grep(
    word: string,
    options?: { pathspecs?: readonly string[]; ignoreCase?: boolean },
  ): Promise<GrepHit[]>;
}

export interface Rename {
  from: string;
  to: string;
  /** 0-100, from git's `R<nnn>` score; directory renames are always 100. */
  similarity: number;
}

export interface ChangeSet {
  /** File renames detected by git (similarity >= 50%). */
  renamed: Rename[];
  deleted: string[];
  added: string[];
  /** Changed in place: content, mode or type (a file replaced by a symlink or submodule). */
  modified: string[];
  /** Derived by `deriveDirectoryRenames`; git itself reports none. */
  renamedDirs: Rename[];
  /** Conditions that may make the change set incomplete, e.g. dropped rename detection. */
  warnings: string[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `a/b/c.txt` → `['a', 'a/b']`. */
function ancestorDirs(path: string): string[] {
  const segments = path.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < segments.length; i++)
    dirs.push(segments.slice(0, i).join("/"));
  return dirs;
}

/**
 * Directory renames implied by file renames: `D → D'` only when EVERY base file
 * under `D/` was renamed to `D'/<same relative path>`. Neither the repository
 * root nor a move into the root counts as a directory rename.
 *
 * When nested directories moved together only the outermost one is returned;
 * an inner directory is kept when it moved somewhere its parent did not.
 * Results are sorted by source directory.
 */
export function deriveDirectoryRenames(
  renames: readonly Rename[],
  baseFiles: readonly string[],
  headFiles?: readonly string[],
): Rename[] {
  const baseSet = new Set(baseFiles);

  // Number of base files under each directory.
  const filesUnder = new Map<string, number>();
  for (const file of baseSet) {
    for (const dir of ancestorDirs(file))
      filesUnder.set(dir, (filesUnder.get(dir) ?? 0) + 1);
  }

  // Each rename votes for every directory pair it is consistent with: peel
  // matching trailing path segments off both sides, what remains are D and D'.
  const toByFrom = new Map<string, string>();
  for (const { from, to } of renames)
    if (baseSet.has(from)) toByFrom.set(from, to);
  const support = new Map<
    string,
    { from: string; to: string; votes: number }
  >();
  for (const [from, to] of toByFrom) {
    const f = from.split("/");
    const t = to.split("/");
    for (
      let k = 1;
      k < f.length && k < t.length && f[f.length - k] === t[t.length - k];
      k++
    ) {
      const dirFrom = f.slice(0, f.length - k).join("/");
      const dirTo = t.slice(0, t.length - k).join("/");
      const key = `${dirFrom}\0${dirTo}`;
      const entry = support.get(key) ?? { from: dirFrom, to: dirTo, votes: 0 };
      entry.votes++;
      support.set(key, entry);
    }
  }

  // Complete candidates have exactly one target each: all their files agree on it.
  const completeTo = new Map<string, string>();
  for (const { from, to, votes } of support.values()) {
    if (votes === filesUnder.get(from)) completeTo.set(from, to);
  }
  const implied = (from: string, to: string): boolean =>
    ancestorDirs(from).some((outer) => {
      const outerTo = completeTo.get(outer);
      return (
        outerTo !== undefined && to === `${outerTo}${from.slice(outer.length)}`
      );
    });

  // With the head listing: a directory that still holds files in head, or that moved
  // into its own subtree (`src` → `src/lib`), was not renamed as a whole.
  const headDirs = new Set<string>();
  for (const file of headFiles ?? [])
    for (const dir of ancestorDirs(file)) headDirs.add(dir);
  const stillThere = (from: string, to: string): boolean =>
    headFiles !== undefined &&
    (headDirs.has(from) || to.startsWith(`${from}/`));

  return [...completeTo]
    .filter(([from, to]) => !implied(from, to) && !stillThere(from, to))
    .map(([from, to]) => ({ from, to, similarity: 100 }))
    .sort((a, b) => compareStrings(a.from, b.from));
}
