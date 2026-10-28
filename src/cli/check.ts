// `drift-ci check`: runs the rules between two commits of a repository and prints the result.
import { ConfigError } from '../core/config.ts';
import type { CheckResult, FailOn, Report } from '../core/finding.ts';
import { GitError } from '../git/errors.ts';
import { runDiffCheck } from '../git/pipeline.ts';
import type { Io } from './io.ts';
import { formatJson, formatText, formatWarnings } from './report.ts';

export type OutputFormat = 'text' | 'json';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json'];

export const FAIL_ON_VALUES: readonly FailOn[] = ['none', 'warning'];

export interface CheckCommandOptions {
  base: string;
  head: string;
  cwd: string;
  format: OutputFormat;
  /** Overrides the `failOn` of the repository's config. */
  failOn?: FailOn;
}

/**
 * Exit code for a result that was produced: 1 when the effective `failOn` (the flag, else the config's) is
 * `warning` and there is at least one finding, else 0.
 */
export function exitCodeFor(report: Report, failOn: FailOn | undefined): number {
  return (failOn ?? report.failOn) === 'warning' && report.findings.length > 0 ? 1 : 0;
}

/** Prints the result (stdout) and its warnings (stderr); returns the exit code. */
export function printReport(report: Report, options: { format: OutputFormat; failOn?: FailOn }, io: Io): number {
  // The JSON carries the failOn the exit code was computed with: the flag wins over the config.
  const shown: Report = options.failOn === undefined ? report : { ...report, failOn: options.failOn };
  io.stdout(options.format === 'json' ? formatJson(shown) : formatText(shown));
  io.stderr(formatWarnings(report));
  return exitCodeFor(report, options.failOn);
}

/**
 * The exit code (2) for an error: git cannot answer (bad ref, not a repository), the head's `.drift-ci.yml` is
 * invalid, or anything else, which is a bug and is printed as `internal error` (never exit 1: that code means
 * findings with `failOn: warning`).
 */
export function reportFailure(error: unknown, io: Io): number {
  if (error instanceof ConfigError) {
    io.stderr(`drift-ci: ${error.message}\n`);
    return 2;
  }
  if (error instanceof GitError) {
    io.stderr(`drift-ci: ${error.message.split('\n')[0]}\n`);
    return 2;
  }
  io.stderr(`drift-ci: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
}

/**
 * Runs the check and prints its result. Returns the process exit code: 0 when the check ran (and, with
 * `failOn: warning`, found nothing), 1 when it found something with `failOn: warning`, 2 when git cannot
 * answer (bad ref, not a repository) or the head's `.drift-ci.yml` is invalid.
 */
export async function runCheckCommand(options: CheckCommandOptions, io: Io): Promise<number> {
  const { base, head, cwd, format, failOn } = options;
  let result: CheckResult;
  try {
    result = await runDiffCheck(cwd, base, head);
  } catch (error) {
    return reportFailure(error, io);
  }
  return printReport(result, { format, ...(failOn ? { failOn } : {}) }, io);
}
