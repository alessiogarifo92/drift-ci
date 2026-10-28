// The loop both modes share: walks the non-shadow references of the head docs, asks a rule about each one
// and turns what it reports into sorted, de-duplicated findings. Pure.
import { isCheckedDoc, matchesIgnore, type DriftConfig } from './config.ts';
import { fingerprint, type Finding } from './finding.ts';
import { indexMarkdown, isIndexedDoc } from './indexer.ts';
import type { Reference } from './reference.ts';
import type { Drift, Rule } from './rules.ts';
import type { RepoIdentity } from './shapes.ts';
import type { RepoSnapshot, SnapshotEntry } from './snapshot.ts';
import { hasHistoricalContext, splitLines, suppressedLines } from './suppress.ts';

export interface CollectOptions {
  rules: readonly Rule[];
  /** How a rule judges one reference: `check` in diff mode, `scan` in scan mode. */
  evaluate: (rule: Rule, ref: Reference, doc: { path: string }) => Drift | undefined;
  repo?: RepoIdentity;
  config?: DriftConfig;
  /** Which head files are docs to index. Default: the config's docs, else `isIndexedDoc`. */
  docFilter?: (path: string) => boolean;
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
 * its line (`drift-ignore` comments, historical wording) or an `ignore` entry of the config matches it.
 */
export async function collectFindings(
  head: RepoSnapshot,
  headFiles: readonly SnapshotEntry[],
  options: CollectOptions,
): Promise<Finding[]> {
  const { rules, evaluate, repo, config } = options;
  const docFilter = options.docFilter ?? (config ? (path: string) => isCheckedDoc(path, config) : isIndexedDoc);

  const docPaths = headFiles.filter((e) => e.kind === 'file' && docFilter(e.path)).map((e) => e.path);
  const contents = await head.readFiles(docPaths);

  const findings = new Map<string, Finding>();
  for (const path of docPaths) {
    const content = contents.get(path);
    if (content === undefined) continue;
    const suppressed = suppressedLines(splitLines(content));
    for (const ref of indexMarkdown(path, content, repo ? { repo } : undefined)) {
      if (ref.shadow || suppressed.has(ref.line) || hasHistoricalContext(ref.contextLine)) continue;
      for (const rule of rules) {
        if (!rule.kinds.includes(ref.kind)) continue;
        const drift = evaluate(rule, ref, { path });
        if (drift === undefined) continue;
        const key = JSON.stringify([rule.id, path, ref.line, ref.col, drift.fact]);
        if (findings.has(key)) continue;
        const finding: Finding = {
          ruleId: rule.id,
          kind: ref.kind,
          fact: drift.fact,
          file: path,
          line: ref.line,
          col: ref.col,
          message: drift.message,
          ...(drift.suggestion === undefined ? {} : { suggestion: drift.suggestion }),
          fingerprint: fingerprint(rule.id, drift.fact, path, ref.contextLine),
        };
        if (config?.ignore.some((entry) => matchesIgnore(entry, finding))) continue;
        findings.set(key, finding);
      }
    }
  }
  return [...findings.values()].sort(compareFindings);
}
