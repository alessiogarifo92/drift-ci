// Scan mode (beta): the references in the docs of one commit that resolve to nothing there. Unlike the
// diff-mode check there is no base to prove the reference once worked, so only rules that implement
// `scan` take part (paths, npm scripts, make targets): environment variables need the diff, and bins
// cannot be told from any other command. Pure: everything comes through the head snapshot.
import { collectFindings } from './collect.ts';
import { disabledRuleIds } from './check.ts';
import type { DriftConfig } from './config.ts';
import { FINDING_SCHEMA_VERSION, type ScanResult } from './finding.ts';
import type { CheckContext, Rule } from './rules.ts';
import type { RepoIdentity } from './shapes.ts';
import type { ChangeSet, RepoSnapshot } from './snapshot.ts';

export interface ScanOptions {
  rules: readonly Rule[];
  /** The repository the docs live in: lets same-repo github.com URLs count as paths. */
  repo?: RepoIdentity;
  /** The head's `.drift-ci.yml`, as in `CheckOptions`. */
  config?: DriftConfig;
  /** Which head files are docs to index. Default: the config's docs, else the built-in docs. */
  docFilter?: (path: string) => boolean;
}

const NO_CHANGES: ChangeSet = { renamed: [], renamedDirs: [], deleted: [], added: [], modified: [], warnings: [] };

/** Findings for every scannable reference of the head docs that does not resolve at head. */
export async function scanSnapshot(head: RepoSnapshot, options: ScanOptions): Promise<ScanResult> {
  const { repo, config } = options;
  const disabled = config ? disabledRuleIds(config) : new Set<string>();
  const rules = options.rules.filter((rule) => rule.scan !== undefined && !disabled.has(rule.id));

  const headFiles = await head.listFiles();
  const warnings: string[] = [];
  // The rules keep a base and a head inventory: both are the scanned commit.
  const ctx: CheckContext = {
    base: head,
    head,
    changes: NO_CHANGES,
    baseFiles: headFiles,
    headFiles,
    hunks: [],
    warn: (message) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
  };
  for (const rule of rules) await rule.prepare(ctx);

  const findings = await collectFindings(head, headFiles, {
    rules,
    evaluate: (rule, ref, doc) => rule.scan?.(ref, doc),
    ...(repo ? { repo } : {}),
    ...(config ? { config } : {}),
    ...(options.docFilter ? { docFilter: options.docFilter } : {}),
  });

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    mode: 'scan',
    head: head.commit,
    findings,
    warnings,
    failOn: config?.failOn ?? 'none',
  };
}
