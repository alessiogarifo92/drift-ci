// Pure analysis core: no filesystem, process or GitHub Actions access here.
// Inputs arrive through adapters (RepoSnapshot, ChangeSet) supplied by the
// CLI or the Action; see docs/decisions.md, phase 3.

/** Version of the JSON finding schema emitted by the reporters. */
export const FINDING_SCHEMA_VERSION = 1;

export interface Finding {
  ruleId: string;
  file: string;
  /** 1-indexed line. */
  line: number;
  /** 1-indexed column, in UTF-16 code units. */
  col: number;
  message: string;
  suggestion?: string;
  fingerprint: string;
}
