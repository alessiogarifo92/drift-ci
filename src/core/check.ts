// The check harness: indexes the docs of the head commit and asks each rule
// whether the references found there drifted in the change. Pure: everything
// it knows about the repository comes through the two snapshots and the change set.
import { collectFindings } from './collect.ts';
import { CHECK_RULE_IDS, type CheckKey, type DriftConfig } from './config.ts';
import { FINDING_SCHEMA_VERSION, type CheckResult } from './finding.ts';
import type { RepoIdentity } from './shapes.ts';
import type { CheckContext, DiffHunk, Rule } from './rules.ts';
import type { ChangeSet, RepoSnapshot } from './snapshot.ts';

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

/** Ids of the rules the config's `checks` switch off. */
export function disabledRuleIds(config: DriftConfig): Set<string> {
  const keys = Object.keys(CHECK_RULE_IDS) as CheckKey[];
  return new Set(keys.filter((key) => !config.checks[key]).map((key) => CHECK_RULE_IDS[key]));
}

/**
 * Findings for the head docs: every non-shadow reference that a rule reports as drifted
 * (see `collectFindings` for ordering and suppression).
 */
export async function runCheck(
  base: RepoSnapshot,
  head: RepoSnapshot,
  changes: ChangeSet,
  options: CheckOptions,
): Promise<CheckResult> {
  const { repo, config, hunks = [] } = options;
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

  const findings = await collectFindings(head, headFiles, {
    rules,
    evaluate: (rule, ref, doc) => rule.check(ref, doc),
    ...(repo ? { repo } : {}),
    ...(config ? { config } : {}),
    ...(options.docFilter ? { docFilter: options.docFilter } : {}),
  });

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    mode: 'diff',
    base: base.commit,
    head: head.commit,
    findings,
    warnings,
    failOn: config?.failOn ?? 'none',
  };
}
