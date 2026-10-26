// `drift-ci check`: runs the rules between two commits of a repository and prints the result.
import { runCheck } from '../core/check.ts';
import type { CheckResult } from '../core/finding.ts';
import { defaultRules } from '../core/rules/index.ts';
import { computeChangeSet } from '../git/changeset.ts';
import { GitError } from '../git/errors.ts';
import { readRepoSlug } from '../git/remote.ts';
import { openSnapshot } from '../git/snapshot.ts';
import type { Io } from './io.ts';

export type OutputFormat = 'text' | 'json';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json'];

export interface CheckCommandOptions {
  base: string;
  head: string;
  cwd: string;
  format: OutputFormat;
}

/** The result document: pretty-printed with two spaces, newline-terminated. */
export function formatJson(result: CheckResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** One line per finding (`file:line:col  message`), its suggestion indented below, then a count. */
export function formatText(result: CheckResult): string {
  let text = '';
  for (const finding of result.findings) {
    text += `${finding.file}:${finding.line}:${finding.col}  ${finding.message}\n`;
    if (finding.suggestion !== undefined) text += `  suggestion: ${finding.suggestion}\n`;
  }
  const count = result.findings.length;
  return `${text}${count} ${count === 1 ? 'finding' : 'findings'}\n`;
}

export function formatWarnings(result: CheckResult): string {
  return result.warnings.map((warning) => `warning: ${warning}\n`).join('');
}

/**
 * Runs the check and prints its result. Returns the process exit code: 0 whenever the check ran
 * (findings do not fail the run yet), 2 when git cannot answer (bad ref, not a repository).
 */
export async function runCheckCommand(options: CheckCommandOptions, io: Io): Promise<number> {
  const { base, head, cwd, format } = options;
  let result: CheckResult;
  try {
    const [baseSnapshot, headSnapshot, changes, repo] = await Promise.all([
      openSnapshot(cwd, base),
      openSnapshot(cwd, head),
      computeChangeSet(cwd, base, head),
      readRepoSlug(cwd),
    ]);
    result = await runCheck(baseSnapshot, headSnapshot, changes, {
      rules: defaultRules(),
      ...(repo ? { repo } : {}),
    });
  } catch (error) {
    if (error instanceof GitError) {
      io.stderr(`drift-ci: ${error.message.split('\n')[0]}\n`);
      return 2;
    }
    throw error;
  }

  io.stdout(format === 'json' ? formatJson(result) : formatText(result));
  io.stderr(formatWarnings(result));
  return 0;
}
