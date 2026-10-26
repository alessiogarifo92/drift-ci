// The check harness: indexes the docs of the head commit and asks each rule
// whether the references found there drifted in the change. Pure: everything
// it knows about the repository comes through the two snapshots and the change set.
import { fingerprint, FINDING_SCHEMA_VERSION, type CheckResult, type Finding } from './finding.ts';
import { indexMarkdown, isIndexedDoc } from './indexer.ts';
import type { CheckContext, DiffHunk, Rule } from './rules.ts';
import type { ChangeSet, RepoSnapshot } from './snapshot.ts';

export interface CheckOptions {
  rules: readonly Rule[];
  /** The repository the docs live in: lets same-repo github.com URLs count as paths. */
  repo?: { owner: string; name: string };
  /** Which head files are docs to index. Default: `isIndexedDoc`. */
  docFilter?: (path: string) => boolean;
  /** Zero-context diff hunks, for rules that look at removed lines (env vars). */
  hunks?: readonly DiffHunk[];
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
 * Findings for the head docs: every non-shadow reference that a rule reports as drifted,
 * sorted by file, line, column and rule, one per (rule, position, fact).
 */
export async function runCheck(
  base: RepoSnapshot,
  head: RepoSnapshot,
  changes: ChangeSet,
  options: CheckOptions,
): Promise<CheckResult> {
  const { rules, repo, docFilter = isIndexedDoc, hunks = [] } = options;

  const [baseFiles, headFiles] = await Promise.all([base.listFiles(), head.listFiles()]);
  const warnings: string[] = [...changes.warnings];
  const ctx: CheckContext = {
    base,
    head,
    changes,
    baseFiles,
    headFiles,
    hunks,
    warn: (message) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
  };
  for (const rule of rules) await rule.prepare(ctx);

  const docPaths = headFiles.filter((e) => e.kind === 'file' && docFilter(e.path)).map((e) => e.path);
  const contents = await head.readFiles(docPaths);

  const findings = new Map<string, Finding>();
  for (const path of docPaths) {
    const content = contents.get(path);
    if (content === undefined) continue;
    for (const ref of indexMarkdown(path, content, repo ? { repo } : undefined)) {
      if (ref.shadow) continue;
      for (const rule of rules) {
        if (!rule.kinds.includes(ref.kind)) continue;
        const drift = rule.check(ref, { path });
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
        findings.set(key, finding);
      }
    }
  }

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    base: base.commit,
    head: head.commit,
    findings: [...findings.values()].sort(compareFindings),
    warnings,
  };
}
