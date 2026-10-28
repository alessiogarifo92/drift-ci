// The contract between the check harness (check.ts) and the rules that decide
// whether a reference found in a head doc has drifted.
import type { Reference, ReferenceKind } from './reference.ts';
import type { ChangeSet, RepoSnapshot, SnapshotEntry } from './snapshot.ts';

/** Changed lines of one file, from a zero-context diff (`git diff -U0 base head`). */
export interface DiffHunk {
  /** Head path; the base path for a deleted file. */
  path: string;
  /** Lines removed in this hunk, without the leading '-'. */
  removed: readonly string[];
  /** Lines added in this hunk, without the leading '+'. */
  added: readonly string[];
}

export interface CheckContext {
  base: RepoSnapshot;
  head: RepoSnapshot;
  changes: ChangeSet;
  /** `base.listFiles()`, fetched once per run. */
  baseFiles: readonly SnapshotEntry[];
  /** `head.listFiles()`, fetched once per run. */
  headFiles: readonly SnapshotEntry[];
  /** Diff hunks between base and head; empty when the caller did not compute them. */
  hunks: readonly DiffHunk[];
  /**
   * Paths the config's `docs.exclude` matches: the rules that build an inventory of packages or makefiles
   * leave them out. Absent without a config.
   */
  excludedPaths?: (path: string) => boolean;
  /** Records a condition that may make the result incomplete; shown next to the findings. */
  warn(message: string): void;
}

export interface Drift {
  /** The drifted thing as resolved, e.g. a repo-relative path. Part of the fingerprint. */
  fact: string;
  message: string;
  /** Replacement text as the doc should write it. */
  suggestion?: string;
}

export interface Rule {
  id: string;
  /** Reference kinds `check` wants to see. */
  kinds: readonly ReferenceKind[];
  /** Called once per run before `check`; build inventories (base vs head) here. */
  prepare(ctx: CheckContext): Promise<void>;
  /** Drift for one non-shadow reference found in a head doc, or `undefined`. */
  check(ref: Reference, doc: { path: string }): Drift | undefined;
  /**
   * Scan mode (beta): drift for a non-shadow reference that resolves to nothing at head, judged without a
   * base (no `renamed`, no suggestion). Called after `prepare` on a context whose base is the head. A rule
   * without it (env, bin) takes no part in a scan: it is neither prepared nor asked.
   */
  scan?(ref: Reference, doc: { path: string }): Drift | undefined;
}
