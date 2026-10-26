// What the Markdown indexer extracts from a doc. Resolving a reference against
// repository contents is the Matcher's job, not the indexer's.

export type ReferenceKind = 'path' | 'npm-script' | 'make-target' | 'env' | 'command';

export type ReferenceSource = 'link' | 'image' | 'definition' | 'inline-code' | 'fence' | 'text';

export interface ReferenceContext {
  /** From a preceding `cd <dir>` in the same fence, `cd dir && ...` or a `-C`/`--prefix` flag; raw as written. */
  cwd?: string;
  /** From `npm -w <pkg>` / `--workspace=<pkg>`, `pnpm --filter <pkg>` / `-F <pkg>`, `yarn workspace <pkg>`. */
  workspace?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
}

export interface Reference {
  kind: ReferenceKind;
  /**
   * path: as written minus a leading `./`, anchor, query and line suffix, percent-decoded for URLs; a leading
   * `/` means repo-root-anchored (also for same-repo github.com blob/tree URLs).
   * npm-script, make-target, env, command: the bare name.
   */
  normalized: string;
  /** Repo-relative path of the doc, as passed in. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** 1-indexed, in UTF-16 code units; the first character of the reference token itself. */
  col: number;
  source: ReferenceSource;
  /** The full source line, without its line terminator. */
  contextLine: string;
  /** Recorded for measurement but never reported (low confidence). */
  shadow: boolean;
  context?: ReferenceContext;
}
