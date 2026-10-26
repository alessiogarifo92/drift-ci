// The finding schema: what a rule reports and what the reporters print.
import { createHash } from 'node:crypto';
import type { ReferenceKind } from './reference.ts';

/** Version of the JSON finding schema emitted by the reporters. */
export const FINDING_SCHEMA_VERSION = 1;

export interface Finding {
  /** The rule that reported it: `path` today; later `npm-script`, `make-target`, `bin`, `env`. */
  ruleId: string;
  /** Kind of the reference that triggered it. */
  kind: ReferenceKind;
  /** The drifted thing as the rule resolved it, e.g. the repo-relative `src/old.ts`. */
  fact: string;
  file: string;
  /** 1-indexed line. */
  line: number;
  /** 1-indexed column, in UTF-16 code units. */
  col: number;
  message: string;
  /** Replacement text as the doc should write it (same style as the original reference). */
  suggestion?: string;
  /** Stable id of the finding across unrelated edits: see `fingerprint`. */
  fingerprint: string;
}

/** The JSON document `drift-ci check --format json` prints. */
export interface CheckResult {
  schemaVersion: typeof FINDING_SCHEMA_VERSION;
  /** Full SHA of the base commit. */
  base: string;
  /** Full SHA of the head commit. */
  head: string;
  findings: Finding[];
  warnings: string[];
}

/**
 * First 16 hex characters of the SHA-256 of `[ruleId, fact, file, normalizedLine]`, where the
 * line is trimmed and its internal whitespace collapsed. Line and column are not part of it, so
 * a finding keeps its fingerprint when lines above it are added or removed.
 */
export function fingerprint(ruleId: string, fact: string, file: string, lineText: string): string {
  const normalizedLine = lineText.trim().replace(/\s+/g, ' ');
  return createHash('sha256')
    .update(JSON.stringify([ruleId, fact, file, normalizedLine]))
    .digest('hex')
    .slice(0, 16);
}
