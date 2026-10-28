// The check harness: indexes the docs of the head commit and asks each rule
// whether the references found there drifted in the change. Pure: everything
// it knows about the repository comes through the two snapshots and the change set.
import { CHECK_RULE_IDS, isCheckedDoc, matchesIgnore, type CheckKey, type DriftConfig } from './config.ts';
import { fingerprint, FINDING_SCHEMA_VERSION, type CheckResult, type Finding } from './finding.ts';
import { indexMarkdown, isIndexedDoc } from './indexer.ts';
import type { RepoIdentity } from './shapes.ts';
import type { CheckContext, DiffHunk, Rule } from './rules.ts';
import type { ChangeSet, RepoSnapshot } from './snapshot.ts';
import { hasHistoricalContext, splitLines, suppressedLines } from './suppress.ts';

export interface CheckOptions {
  rules: readonly Rule[];
  /** The repository the docs live in: lets same-repo github.com URLs count as paths. */
  repo?: RepoIdentity;
  /**
   * The head's `.drift-ci.yml`: which docs to check (`docs`), which rules run (`checks`), which
   * findings to drop (`ignore`) and `failOn`, which the result carries. Without it every built-in
   * rule runs on the built-in docs, nothing is ignored and `failOn` is `none`.
   */
  config?: DriftConfig;
  /** Which head files are docs to index. Default: the config's docs, else `isIndexedDoc`. */
  docFilter?: (path: string) => boolean;
  /** Zero-context diff hunks, for rules that look at removed lines (env vars). */
  hunks?: readonly DiffHunk[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ids of the rules the config's `checks` switch off. */
function disabledRuleIds(config: DriftConfig): Set<string> {
  const keys = Object.keys(CHECK_RULE_IDS) as CheckKey[];
  return new Set(keys.filter((key) => !config.checks[key]).map((key) => CHECK_RULE_IDS[key]));
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
 * sorted by file, line, column and rule, one per (rule, position, fact). A finding is dropped
 * when the doc suppresses its line (`drift-ignore` comments, historical wording) or an `ignore`
 * entry of the config matches it.
 */
export async function runCheck(
  base: RepoSnapshot,
  head: RepoSnapshot,
  changes: ChangeSet,
  options: CheckOptions,
): Promise<CheckResult> {
  const { repo, config, hunks = [] } = options;
  const docFilter = options.docFilter ?? (config ? (path: string) => isCheckedDoc(path, config) : isIndexedDoc);
  const disabled = config ? disabledRuleIds(config) : new Set<string>();
  const rules = options.rules.filter((rule) => !disabled.has(rule.id));

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
    const suppressed = suppressedLines(splitLines(content));
    for (const ref of indexMarkdown(path, content, repo ? { repo } : undefined)) {
      if (ref.shadow || suppressed.has(ref.line) || hasHistoricalContext(ref.contextLine)) continue;
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
        if (config?.ignore.some((entry) => matchesIgnore(entry, finding))) continue;
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
    failOn: config?.failOn ?? 'none',
  };
}
