// Reporters: how a result of either mode is printed. Plain ASCII, no colour, so the output is
// the same on a terminal, in a CI log and in a snapshot test.
import type { Finding, Report } from "../core/finding.ts";

/** The result document: pretty-printed with two spaces, newline-terminated. */
export function formatJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Findings grouped by file (the report is sorted by file already), one `line:col  message` line each with
 * its suggestion indented below, then `N findings in M files`. Without findings: `0 findings`.
 */
export function formatText(report: Report): string {
  const { findings } = report;
  if (findings.length === 0) return "0 findings\n";

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = byFile.get(finding.file);
    if (group) group.push(finding);
    else byFile.set(finding.file, [finding]);
  }
  const position = (f: Finding) => `${f.line}:${f.col}`;
  const width = Math.max(...findings.map((f) => position(f).length));

  let text = "";
  for (const [file, group] of byFile) {
    text += `${file}\n`;
    for (const finding of group) {
      text += `  ${position(finding).padEnd(width)}  ${finding.message}\n`;
      if (finding.suggestion !== undefined)
        text += `    -> ${finding.suggestion}\n`;
    }
    text += "\n";
  }
  return `${text}${plural(findings.length, "finding")} in ${plural(byFile.size, "file")}\n`;
}

/** One `warning: …` line per warning, for stderr. */
export function formatWarnings(report: Report): string {
  return report.warnings.map((warning) => `warning: ${warning}\n`).join("");
}
