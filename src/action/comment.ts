// The sticky PR comment: one per pull request, found by its hidden marker and edited in place.
import type { CheckResult } from '../core/finding.ts';
import type { GitHubClient, IssueComment } from './github.ts';
import { COMMENT_MARKER, renderComment, renderNoDriftComment, type RenderContext } from './render.ts';

export type CommentOutcome = 'created' | 'updated' | 'unchanged' | 'none';

// Only the Actions bot's own comment counts: anyone can paste the marker into a comment.
function isStickyComment(comment: IssueComment): boolean {
  return comment.user?.type === 'Bot' && comment.body.split('\n', 1)[0]?.trimEnd() === COMMENT_MARKER;
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
  const existing = (await client.listIssueComments(pr)).find(isStickyComment);
  const hasFindings = result.findings.length > 0;
  if (!existing && !hasFindings) return 'none';

  const body = hasFindings ? renderComment(result, ctx) : renderNoDriftComment(ctx);
  if (!existing) {
    await client.createComment(pr, body);
    return 'created';
  }
  if (existing.body === body) return 'unchanged';
  await client.updateComment(existing.id, body);
  return 'updated';
}
