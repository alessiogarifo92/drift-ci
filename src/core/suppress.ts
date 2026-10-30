// Suppression of findings by what the doc itself says: inline `drift-ignore` comments and
// historical wording on the line. Pure: strings in, line numbers and booleans out.

/** The lines of a doc as the indexer numbers them: no BOM, CRLF and CR read as `\n`. */
export function splitLines(content: string): string[] {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
}

const DIRECTIVE = /<!--\s*drift-ignore-(next-line|start|end)\s*-->/gi;

/**
 * 1-indexed lines whose findings are suppressed by inline comments, matched case-insensitively
 * and accepted anywhere in a line:
 * - `<!-- drift-ignore-next-line -->` suppresses the next non-blank line;
 * - `<!-- drift-ignore-start -->` ... `<!-- drift-ignore-end -->` suppresses the lines strictly
 *   between them, or every line to the end of the doc when the start is never closed.
 * The lines holding the comments themselves are not suppressed.
 */
export function suppressedLines(lines: readonly string[]): Set<number> {
  const suppressed = new Set<number>();
  let inBlock = false;
  let nextLine = false;
  lines.forEach((line, index) => {
    const directives = [...line.matchAll(DIRECTIVE)].map((m) =>
      (m[1] as string).toLowerCase(),
    );
    const number = index + 1;
    if (inBlock && !directives.includes("end")) suppressed.add(number);
    if (nextLine && line.trim() !== "") {
      suppressed.add(number);
      nextLine = false;
    }
    for (const directive of directives) {
      if (directive === "start") inBlock = true;
      else if (directive === "end") inBlock = false;
      else nextLine = true;
    }
  });
  return suppressed;
}

/** Keywords that say the line talks about the past, so naming a gone thing there is not drift. */
const HISTORICAL = new RegExp(
  [
    "renamed\\s+from",
    "formerly",
    "deprecated",
    "removed\\s+in",
    "previously",
    // The PR's own docs saying where the thing went: "moved to", "was removed", "replaced by", "no longer"...
    "moved\\s+(?:from|to)",
    "renamed\\s+to",
    "(?:was|were|has\\s+been|have\\s+been)\\s+(?:removed|deleted|renamed|moved|replaced)",
    "replaced\\s+(?:by|with)",
    "no\\s+longer",
    "used\\s+to\\s+be",
    "(?:was|were)\\s+(?:named|called)",
    "now\\s+(?:lives|called|named)",
  ]
    .map((alternative) => `\\b(?:${alternative})\\b`)
    .join("|"),
  "i",
);

/**
 * Whether the line says it describes something old or something that changed: "renamed from", "formerly",
 * "deprecated", "removed in", "previously", "moved from/to", "renamed to", "was/has been removed...",
 * "replaced by/with", "no longer", "used to be", "now lives/called/named".
 */
export function hasHistoricalContext(line: string): boolean {
  return HISTORICAL.test(line);
}
