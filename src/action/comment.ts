// The sticky PR comment: one per pull request, found by its hidden marker and edited in place.
import type { CheckResult } from "../core/finding.ts";
import type { GitHubClient, IssueComment } from "./github.ts";
import {
  COMMENT_MARKER,
  renderComment,
  renderNoDriftComment,
  type RenderContext,
} from "./render.ts";

export type CommentOutcome = "created" | "updated" | "unchanged" | "none";

/** The login the Actions `GITHUB_TOKEN` posts as. */
const ACTIONS_BOT = "github-actions[bot]";

// Only our own comment counts, since anyone can paste the marker into a comment: the Actions bot's, or the
// one of the user the token belongs to (a PAT or an app token, which `GET /user` names).
function isStickyComment(
  comment: IssueComment,
  viewer: string | undefined,
): boolean {
  const login = comment.user?.login;
  const ours =
    login === ACTIONS_BOT || (viewer !== undefined && login === viewer);
  return ours && comment.body.split("\n", 1)[0]?.trimEnd() === COMMENT_MARKER;
}

/**
 * Creates or updates the sticky comment on pull request `pr`. With no findings an existing comment
 * is edited to say so (never deleted, so the history stays readable); without one nothing is posted.
 * Rejects with the client's error, e.g. GitHubApiError 403 without `pull-requests: write`.
 */
export async function upsertStickyComment(
  client: GitHubClient,
  pr: number,
  result: CheckResult,
  ctx: RenderContext,
): Promise<CommentOutcome> {
  const comments = await client.listIssueComments(pr);
  let existing = comments.find((c) => isStickyComment(c, undefined));
  if (existing === undefined) {
    const viewer = await client.viewerLogin(); // a PAT or an app token posts as that user, not as the Actions bot
    if (viewer !== undefined)
      existing = comments.find((c) => isStickyComment(c, viewer));
  }
  const hasFindings = result.findings.length > 0;
  if (!existing && !hasFindings) return "none";

  const body = hasFindings
    ? renderComment(result, ctx)
    : renderNoDriftComment(ctx, result);
  if (!existing) {
    await client.createComment(pr, body);
    return "created";
  }
  if (existing.body === body) return "unchanged";
  await client.updateComment(existing.id, body);
  return "updated";
}
