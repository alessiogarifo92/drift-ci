// Runs one rule over in-memory base/head trees, the way the unit tests of the
// package, script, bin and make rules need it.
import { runCheck } from '../../src/core/check.ts';
import { defaultConfig } from '../../src/core/config.ts';
import type { CheckResult, Finding } from '../../src/core/finding.ts';
import type { Rule } from '../../src/core/rules.ts';
import { changeSet, memorySnapshot } from './memory-snapshot.ts';

export type Files = Record<string, string>;

export interface Scenario {
  base: Files;
  head: Files;
  /** What the diff touched; default: nothing. */
  changes?: Parameters<typeof changeSet>[0];
  /** `docs.exclude` globs of the config. */
  exclude?: readonly string[];
}

export function runRule(rule: Rule, s: Scenario): Promise<CheckResult> {
  return runCheck(memorySnapshot(s.base), memorySnapshot(s.head), changeSet(s.changes), {
    rules: [rule],
    ...(s.exclude ? { config: { ...defaultConfig(), docs: { include: [], exclude: [...s.exclude] } } } : {}),
  });
}

export async function findingsOf(rule: Rule, s: Scenario): Promise<Finding[]> {
  return (await runRule(rule, s)).findings;
}

/** `fact -> suggestion` (or `none`), the essence of what was flagged. */
export async function briefOf(rule: Rule, s: Scenario): Promise<string[]> {
  return (await findingsOf(rule, s)).map((f) => `${f.fact} -> ${f.suggestion ?? 'none'}`);
}

/** A package.json with the given scripts (and any extra fields). */
export function pkg(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, null, 2);
}
