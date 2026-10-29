// The loop both modes share: walks the non-shadow references of the head docs, asks a rule about each one
// and turns what it reports into sorted, de-duplicated findings. Pure.
import { isCheckedDoc, matchesIgnore, type DriftConfig } from "./config.ts";
import { fingerprint, type Finding } from "./finding.ts";
import { indexMarkdown, isIndexedDoc } from "./indexer.ts";
import type { Reference } from "./reference.ts";
import type { Drift, Rule } from "./rules.ts";
import type { RepoIdentity } from "./shapes.ts";
import type { RepoSnapshot, SnapshotEntry } from "./snapshot.ts";
import {
  hasHistoricalContext,
  splitLines,
  suppressedLines,
} from "./suppress.ts";

export interface CollectOptions {
  rules: readonly Rule[];
  /** How a rule judges one reference: `check` in diff mode, `scan` in scan mode. */
  evaluate: (
    rule: Rule,
    ref: Reference,
    doc: { path: string },
  ) => Drift | undefined;
  repo?: RepoIdentity;
  config?: DriftConfig;
  /** Which head files are docs to index. Default: the config's docs, else `isIndexedDoc`. */
  docFilter?: (path: string) => boolean;
  /** Records a doc that was skipped (too large, nested too deep); shown next to the findings. */
  warn?: (message: string) => void;
  /**
   * When given, a doc is parsed only if its text (lowercase, backslashes removed) contains one of these
   * lowercase strings; the others cannot hold a reference `evaluate` would report (see `Rule.needles`).
   */
  needles?: readonly string[];
}

/** Whether a doc's text contains one of `needles`, compared the way `Rule.needles` defines. */
export function mentionsAny(
  content: string,
  needles: readonly string[],
): boolean {
  if (needles.length === 0) return false;
  const text = content.toLowerCase().replaceAll("\\", "");
  return needles.some((needle) => text.includes(needle));
}

/** Larger docs are skipped: they come from the head of a pull request and the parser is not free. */
export const MAX_DOC_CHARS = 1_000_000;

/** Longest run of indentation and `>` marks at the start of a line; deeper nesting makes the parser crash or crawl. */
const MAX_NESTING_PREFIX = 200;
const NESTING_PREFIX = new RegExp(`^[ \\t>]{${MAX_NESTING_PREFIX + 1},}`, "m");

/** The references of a doc, or why it was skipped: `undefined` plus a warning. */
function indexSafely(
  path: string,
  content: string,
  repo: RepoIdentity | undefined,
  warn: (m: string) => void,
): Reference[] | undefined {
  if (content.length > MAX_DOC_CHARS) {
    warn(`${path}: skipped, larger than 1 MB`);
    return undefined;
  }
  if (NESTING_PREFIX.test(content)) {
    warn(`${path}: skipped, nesting too deep`);
    return undefined;
  }
  try {
    return indexMarkdown(path, content, repo ? { repo } : undefined);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error; // stack overflow of a pathological structure
    warn(`${path}: skipped, nesting too deep`);
    return undefined;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    compareStrings(a.file, b.file) ||
    a.line - b.line ||
    a.col - b.col ||
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.fact, b.fact)
  );
}

/**
 * Findings for the head docs: every non-shadow reference that `evaluate` reports as drifted, sorted by
 * file, line, column and rule, one per (rule, position, fact). A finding is dropped when the doc suppresses
 * its line (`drift-ignore` comments, historical wording, a line that already holds the suggested replacement) or an `ignore` entry of the config matches it.
 */
export async function collectFindings(
  head: RepoSnapshot,
  headFiles: readonly SnapshotEntry[],
  options: CollectOptions,
): Promise<Finding[]> {
  const { rules, evaluate, repo, config } = options;
  const docFilter =
    options.docFilter ??
    (config ? (path: string) => isCheckedDoc(path, config) : isIndexedDoc);

  const docPaths = headFiles
    .filter((e) => e.kind === "file" && docFilter(e.path))
    .map((e) => e.path);
  if (options.needles?.length === 0) return [];
  const contents = await head.readFiles(docPaths);

  const findings = new Map<string, Finding>();
  for (const path of docPaths) {
    const content = contents.get(path);
    if (content === undefined) continue;
    if (options.needles !== undefined && !mentionsAny(content, options.needles))
      continue;
    const refs = indexSafely(
      path,
      content,
      repo,
      options.warn ?? (() => undefined),
    );
    if (refs === undefined) continue;
    const suppressed = suppressedLines(splitLines(content));
    for (const ref of refs) {
      if (
        ref.shadow ||
        suppressed.has(ref.line) ||
        hasHistoricalContext(ref.contextLine)
      )
        continue;
      for (const rule of rules) {
        if (!rule.kinds.includes(ref.kind)) continue;
        const drift = evaluate(rule, ref, { path });
        if (drift === undefined) continue;
        // The author already wrote the new name next to the old one: nothing left to fix.
        if (
          drift.suggestion !== undefined &&
          ref.contextLine.includes(drift.suggestion)
        )
          continue;
        const key = JSON.stringify([
          rule.id,
          path,
          ref.line,
          ref.col,
          drift.fact,
        ]);
        if (findings.has(key)) continue;
        const finding: Finding = {
          ruleId: rule.id,
          kind: ref.kind,
          fact: drift.fact,
          file: path,
          line: ref.line,
          col: ref.col,
          message: drift.message,
          ...(drift.suggestion === undefined
            ? {}
            : { suggestion: drift.suggestion }),
          fingerprint: fingerprint(rule.id, drift.fact, path, ref.contextLine),
        };
        if (config?.ignore.some((entry) => matchesIgnore(entry, finding)))
          continue;
        findings.set(key, finding);
      }
    }
  }
  return [...findings.values()].sort(compareFindings);
}
