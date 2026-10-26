// In-memory RepoSnapshot and ChangeSet builders for pure unit tests of rules.
import type { ChangeSet, EntryKind, GrepHit, RepoSnapshot, SnapshotEntry } from '../../src/core/snapshot.ts';

export interface MemorySnapshotOptions {
  commit?: string;
  /** Repo-relative paths that are symlinks (their content is the link target). */
  symlinks?: readonly string[];
  /** Repo-relative submodule paths (gitlinks): listed as entries, never readable. */
  submodules?: readonly string[];
}

const MODES: Readonly<Record<EntryKind, string>> = { file: '100644', symlink: '120000', submodule: '160000' };

function wholeWord(text: string, word: string): boolean {
  let from = text.indexOf(word);
  while (from >= 0) {
    const before = text[from - 1];
    const after = text[from + word.length];
    if (!(before !== undefined && /\w/.test(before)) && !(after !== undefined && /\w/.test(after))) return true;
    from = text.indexOf(word, from + 1);
  }
  return false;
}

/** A snapshot of `files` (path → content), sorted by path like the git adapter. */
export function memorySnapshot(
  files: Readonly<Record<string, string>>,
  options: MemorySnapshotOptions = {},
): RepoSnapshot {
  const symlinks = new Set(options.symlinks ?? []);
  const entries: SnapshotEntry[] = [
    ...Object.keys(files).map((path): SnapshotEntry => {
      const kind: EntryKind = symlinks.has(path) ? 'symlink' : 'file';
      return { path, kind, mode: MODES[kind], oid: `blob:${path}` };
    }),
    ...(options.submodules ?? []).map(
      (path): SnapshotEntry => ({ path, kind: 'submodule', mode: MODES.submodule, oid: `commit:${path}` }),
    ),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const readFiles = async (paths: readonly string[]): Promise<Map<string, string>> => {
    const result = new Map<string, string>();
    for (const path of paths) {
      const content = files[path];
      if (content !== undefined) result.set(path, content);
    }
    return result;
  };

  return {
    commit: options.commit ?? 'c'.repeat(40),
    listFiles: async () => entries,
    readFile: async (path) => files[path],
    readFiles,
    grep: async (word) => {
      const hits: GrepHit[] = [];
      for (const [path, content] of Object.entries(files)) {
        content.split('\n').forEach((text, i) => {
          if (wholeWord(text, word)) hits.push({ path, line: i + 1, text });
        });
      }
      return hits;
    },
  };
}

/** A ChangeSet with every list empty unless given. Renames default to similarity 100. */
export function changeSet(
  parts: {
    renamed?: readonly { from: string; to: string }[];
    renamedDirs?: readonly { from: string; to: string }[];
    deleted?: readonly string[];
    added?: readonly string[];
    modified?: readonly string[];
    warnings?: readonly string[];
  } = {},
): ChangeSet {
  const rename = (r: { from: string; to: string }) => ({ ...r, similarity: 100 });
  return {
    renamed: (parts.renamed ?? []).map(rename),
    renamedDirs: (parts.renamedDirs ?? []).map(rename),
    deleted: [...(parts.deleted ?? [])],
    added: [...(parts.added ?? [])],
    modified: [...(parts.modified ?? [])],
    warnings: [...(parts.warnings ?? [])],
  };
}
