// Markdown for the sticky PR comment and the job summary. Pure: no I/O.
// Finding messages quote text from the docs under check, which anyone with a PR can write, so
// everything that comes from a doc is neutralised before it reaches a comment: no @-mentions,
// no HTML, no links or tables built from doc text.
import type { CheckResult, Finding } from "../core/finding.ts";

/** First line of the sticky comment; the next run finds the comment by it. */
export const COMMENT_MARKER = "<!-- drift-ci:sticky-comment -->";

/** GitHub rejects comment bodies over 65 536 characters. */
export const MAX_COMMENT_CHARS = 60_000;

/** The job summary is limited to 1 MiB. */
const MAX_SUMMARY_CHARS = 900_000;

const PROJECT_URL = "https://github.com/alessiogarifo92/drift-ci";
const ZERO_WIDTH_SPACE = "​";

export interface RenderContext {
  /** `GITHUB_SERVER_URL`, without a trailing slash. */
  serverUrl: string;
  owner: string;
  repo: string;
  /** `pull_request.head.sha`: permalinks stay valid after the branch moves. */
  headSha: string;
}

/** Shown above the findings when the pull request edits the config the check ran with. */
export const CONFIG_NOTE =
  "This pull request changes .drift-ci.yml; the check used the base branch configuration, so the change applies once this is merged.";

/** Rendered Markdown has no line anchors: these files are linked as source (`?plain=1`). */
const MARKDOWN_FILE = /\.(?:md|mdx|markdown|mdc)$/i;

/** Link to `file` at `line` in the head commit; every path segment is percent-encoded. */
export function permalink(
  ctx: RenderContext,
  file: string,
  line: number,
): string {
  const path = file
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `${ctx.serverUrl}/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/blob/${ctx.headSha}/${path}${MARKDOWN_FILE.test(file) ? "?plain=1" : ""}#L${line}`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
};

/**
 * Doc-derived text as plain, inert Markdown: HTML escaped, `@` followed by a zero-width space so
 * it never mentions anyone, Markdown punctuation backslash-escaped, newlines flattened.
 */
export function neutralizeText(text: string): string {
  return (
    text
      .replace(/\r\n|\r|\n/g, " ")
      .replace(/[\\`*_~[\]|<>&@]/g, (char) => {
        if (char === "@") return `@${ZERO_WIDTH_SPACE}`;
        return HTML_ESCAPES[char] ?? `\\${char}`;
      })
      // Autolinks and cross-references GitHub would create from plain text: `https://x`, `www.x`, `owner/repo#1`, `#1`, `GH-1`.
      .replace(/:\/\//g, `://${ZERO_WIDTH_SPACE}`)
      .replace(/\bwww\./gi, (match) => `${match}${ZERO_WIDTH_SPACE}`)
      .replace(/(?<=[\w/])#|#(?=\d)/g, `${ZERO_WIDTH_SPACE}#`)
      .replace(/\b(GH)(?=-\d)/gi, `$1${ZERO_WIDTH_SPACE}`)
  );
}

/** An inline code span that the content cannot break out of. Code spans do not mention or render HTML. */
function codeSpan(text: string): string {
  const content = text.replace(/\r\n|\r|\n/g, " ");
  const longestRun = Math.max(
    0,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

/** A rule's message: its own `code` spans stay code, everything between them is neutralised. */
function renderMessage(message: string): string {
  let out = "";
  let last = 0;
  for (const match of message.matchAll(/`([^`]*)`/g)) {
    out += neutralizeText(message.slice(last, match.index));
    out += codeSpan(match[1] ?? "");
    last = match.index + match[0].length;
  }
  return out + neutralizeText(message.slice(last));
}

function renderFinding(finding: Finding, ctx: RenderContext): string {
  const link = `[${codeSpan(`${finding.file}:${finding.line}`)}](${permalink(ctx, finding.file, finding.line)})`;
  const lines = [`- ${link}: ${renderMessage(finding.message)}`];
  if (finding.suggestion !== undefined)
    lines.push(`  Suggestion: ${codeSpan(finding.suggestion)}`);
  return lines.join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function heading(count: number): string {
  return `### Drift CI: ${plural(count, "doc reference")} may be out of date`;
}

function shortSha(ctx: RenderContext): string {
  return ctx.headSha.slice(0, 7);
}

const INTRO = (ctx: RenderContext) =>
  `This pull request renamed or removed things that docs still mention (checked against \`${shortSha(ctx)}\`):`;

/** Header + as many findings as fit in `maxChars` + an overflow line + footer. */
function renderCapped(
  header: string,
  items: string[],
  footer: string,
  maxChars: number,
): string {
  const overflow = (hidden: number) =>
    hidden === 0
      ? ""
      : `\n… ${plural(hidden, "more finding")}, see the job summary\n`;
  const assemble = (shown: number) =>
    `${header}${items.slice(0, shown).join("\n")}\n${overflow(items.length - shown)}${footer}`;

  const full = assemble(items.length);
  if (full.length <= maxChars) return full;
  let shown = 0;
  while (shown < items.length && assemble(shown + 1).length <= maxChars)
    shown++;
  return assemble(shown);
}

export interface RenderCommentOptions {
  /** Default: MAX_COMMENT_CHARS. */
  maxChars?: number;
}

/** The config-changed note as a block, or nothing. */
function configNote(result: CheckResult): string {
  return result.configChanged === true ? `> ${CONFIG_NOTE}\n\n` : "";
}

/** The sticky comment for a result with findings. */
export function renderComment(
  result: CheckResult,
  ctx: RenderContext,
  options: RenderCommentOptions = {},
): string {
  const header = `${COMMENT_MARKER}\n${configNote(result)}${heading(result.findings.length)}\n\n${INTRO(ctx)}\n\n`;
  const footer = `\n<sub>Updated on every push by [drift-ci](${PROJECT_URL}).</sub>\n`;
  const items = result.findings.map((finding) => renderFinding(finding, ctx));
  return renderCapped(
    header,
    items,
    footer,
    options.maxChars ?? MAX_COMMENT_CHARS,
  );
}

/** What an existing sticky comment becomes once the findings are gone. */
export function renderNoDriftComment(
  ctx: RenderContext,
  result?: CheckResult,
): string {
  return `${COMMENT_MARKER}\n${result ? configNote(result) : ""}### Drift CI: no drift found\n\nNo drift found in \`${shortSha(ctx)}\`: no doc references to things this pull request renamed or removed.\n`;
}

/** The job summary: every finding, the warnings of the run and `notes` (what was not done, and why). */
export function renderSummary(
  result: CheckResult,
  ctx: RenderContext,
  notes: readonly string[],
): string {
  const parts: string[] = [];
  if (result.configChanged === true) parts.push(`> ${CONFIG_NOTE}\n`);
  if (result.findings.length === 0) {
    parts.push(
      `### Drift CI: no drift found\n\nNo drift found in \`${shortSha(ctx)}\`.\n`,
    );
  } else {
    const items = result.findings.map((finding) => renderFinding(finding, ctx));
    parts.push(
      renderCapped(
        `${heading(result.findings.length)}\n\n${INTRO(ctx)}\n\n`,
        items,
        "",
        MAX_SUMMARY_CHARS,
      ),
    );
  }
  for (const note of notes) parts.push(`${note}\n`);
  if (result.warnings.length > 0) {
    parts.push(
      `#### Warnings\n\n${result.warnings.map((w) => `- ${neutralizeText(w)}`).join("\n")}\n`,
    );
  }
  return parts.join("\n");
}
