// Git-backed RepoSnapshot: every read goes through the commit's SHA
// (ls-tree, cat-file, grep <sha>), never through a working tree.
import type {
  EntryKind,
  GrepHit,
  RepoSnapshot,
  SnapshotEntry,
} from "../core/snapshot.ts";
import { GitError } from "./errors.ts";
import { resolveCommit } from "./revision.ts";
import { runGit, type GitOptions } from "./run.ts";

const MODE_SYMLINK = "120000";
const MODE_GITLINK = "160000";

function kindOf(mode: string): EntryKind {
  if (mode === MODE_GITLINK) return "submodule";
  if (mode === MODE_SYMLINK) return "symlink";
  return "file";
}

/** Parses `git ls-tree -r -z`: `<mode> SP <type> SP <oid> TAB <path> NUL` per entry. */
export function parseLsTree(output: Buffer): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    if (tab < 0 || mode === undefined || oid === undefined) {
      throw new GitError(
        `unexpected git ls-tree record: ${JSON.stringify(record)}`,
      );
    }
    entries.push({
      path: record.slice(tab + 1),
      kind: kindOf(mode),
      mode,
      oid,
    });
  }
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * Parses `git cat-file --batch` output for object ids given on stdin: a header
 * line `<oid> <type> <size>` (or `<oid> missing`), then `size` bytes and a newline.
 */
export function parseCatFileBatch(output: Buffer): Map<string, string> {
  const contents = new Map<string, string>();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0)
      throw new GitError("truncated git cat-file --batch output");
    const [oid, type, size] = output
      .toString("utf8", offset, headerEnd)
      .split(" ");
    offset = headerEnd + 1;
    if (oid === undefined || type === "missing") continue;
    const length = Number(size);
    if (!Number.isInteger(length) || offset + length > output.length) {
      throw new GitError(`unexpected git cat-file --batch header for ${oid}`);
    }
    contents.set(oid, output.toString("utf8", offset, offset + length));
    offset += length + 1; // the object is followed by a newline
  }
  return contents;
}

/** Parses `git grep -z -n`: `<sha>:<path> NUL <line> NUL <text> LF` per hit. */
export function parseGrep(output: Buffer, commit: string): GrepHit[] {
  const hits: GrepHit[] = [];
  const prefix = `${commit}:`;
  let offset = 0;
  const take = (terminator: number): string => {
    const end = output.indexOf(terminator, offset);
    const stop = end < 0 ? output.length : end;
    const field = output.toString("utf8", offset, stop);
    offset = stop + 1;
    return field;
  };
  while (offset < output.length) {
    const location = take(0);
    const line = Number(take(0));
    const text = take(0x0a);
    if (!location.startsWith(prefix) || !Number.isInteger(line)) {
      throw new GitError(
        `unexpected git grep output near ${JSON.stringify(location)}`,
      );
    }
    hits.push({ path: location.slice(prefix.length), line, text });
  }
  return hits;
}

/**
 * Opens a snapshot of the commit `rev` in the repository at `repoDir`
 * (its top-level directory). Works on shallow clones for any commit that was fetched.
 *
 * Rejects with `UnknownRevisionError` when `rev` does not resolve to a commit and
 * `GitNotFoundError` when git cannot be started.
 */
export async function openSnapshot(
  repoDir: string,
  rev: string,
  options: GitOptions = {},
): Promise<RepoSnapshot> {
  const commit = await resolveCommit(repoDir, rev, options);

  let listing:
    | Promise<{ entries: SnapshotEntry[]; byPath: Map<string, SnapshotEntry> }>
    | undefined;
  const list = (): Promise<{
    entries: SnapshotEntry[];
    byPath: Map<string, SnapshotEntry>;
  }> => {
    listing ??= runGit(
      repoDir,
      ["ls-tree", "-r", "-z", "--full-tree", commit],
      options,
    ).then(
      ({ stdout }) => {
        const entries = parseLsTree(stdout);
        return {
          entries,
          byPath: new Map(entries.map((entry) => [entry.path, entry])),
        };
      },
      (error: unknown) => {
        listing = undefined; // do not cache a failure
        throw error;
      },
    );
    return listing;
  };

  const readFiles = async (
    paths: readonly string[],
  ): Promise<Map<string, string>> => {
    const { byPath } = await list();
    // Blobs are requested by object id: a path may contain a newline, which the
    // line-based --batch input cannot carry.
    const found: { path: string; oid: string }[] = [];
    for (const path of new Set(paths)) {
      const entry = byPath.get(path);
      if (entry !== undefined && entry.kind !== "submodule")
        found.push({ path, oid: entry.oid });
    }
    const result = new Map<string, string>();
    if (found.length === 0) return result;

    const oids = [...new Set(found.map((f) => f.oid))];
    const { stdout } = await runGit(repoDir, ["cat-file", "--batch"], {
      ...options,
      input: `${oids.join("\n")}\n`,
    });
    const contents = parseCatFileBatch(stdout);
    for (const { path, oid } of found) {
      const content = contents.get(oid);
      if (content !== undefined) result.set(path, content);
    }
    return result;
  };

  return {
    commit,
    listFiles: async () => (await list()).entries,
    readFile: async (path) => (await readFiles([path])).get(path),
    readFiles,
    grep: async (word, grepOptions = {}) => {
      if (word === "" || word.includes("\n")) {
        throw new RangeError("grep word must be a non-empty single line");
      }
      const pathspecs = grepOptions.pathspecs ?? [];
      const { stdout } = await runGit(
        repoDir,
        [
          "grep",
          "-z",
          "-n",
          "--no-column",
          "-F",
          "-w",
          "-I",
          "--no-color",
          "--no-recurse-submodules",
          ...(grepOptions.ignoreCase === true ? ["-i"] : []),
          "-e",
          word,
          commit,
          ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
        ],
        { ...options, okExitCodes: [1] }, // exit code 1: no match
      );
      return parseGrep(stdout, commit);
    },
  };
}
