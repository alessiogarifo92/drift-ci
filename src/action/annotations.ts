// Workflow-command annotations: GitHub shows at most 10 warnings per step, so the rest go to the summary.
import type { Finding } from "../core/finding.ts";
import type { ActionCore } from "./core.ts";

export const MAX_ANNOTATIONS = 10;

export function emitAnnotations(
  core: ActionCore,
  findings: readonly Finding[],
): void {
  for (const finding of findings.slice(0, MAX_ANNOTATIONS)) {
    const suggestion =
      finding.suggestion === undefined
        ? ""
        : ` (suggestion: ${finding.suggestion})`;
    core.warning(`${finding.message}${suggestion}`, {
      title: "drift-ci",
      file: finding.file,
      startLine: finding.line,
      startColumn: finding.col,
    });
  }
  const hidden = findings.length - MAX_ANNOTATIONS;
  if (hidden > 0)
    core.notice(
      `${hidden} more ${hidden === 1 ? "finding" : "findings"} in the job summary`,
    );
}
