// `drift-ci scan` (beta): the references of one commit's docs that resolve to nothing there.
import type { FailOn, ScanResult } from "../core/finding.ts";
import { runScan } from "../git/pipeline.ts";
import { printReport, reportFailure, type OutputFormat } from "./check.ts";
import type { Io } from "./io.ts";

export interface ScanCommandOptions {
  head: string;
  cwd: string;
  format: OutputFormat;
  /** Overrides the `failOn` of the repository's config. */
  failOn?: FailOn;
}

/** First line of a scan's stderr: what the output is and how far to trust it. */
export function scanBanner(head: string): string {
  return (
    `scan mode (beta): references in docs at ${head.slice(0, 7)} that do not exist there ` +
    "(paths, npm scripts, make targets only); expect false positives\n"
  );
}

/** Same exit codes as `check`: 0, 1 (findings with `failOn: warning`), 2 (usage or runtime error). */
export async function runScanCommand(
  options: ScanCommandOptions,
  io: Io,
): Promise<number> {
  const { head, cwd, format, failOn } = options;
  let result: ScanResult;
  try {
    result = await runScan(cwd, head);
  } catch (error) {
    return reportFailure(error, io);
  }
  io.stderr(scanBanner(result.head));
  return printReport(result, { format, ...(failOn ? { failOn } : {}) }, io);
}
