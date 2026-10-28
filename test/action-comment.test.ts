import { describe, expect, it } from 'vitest';
import { upsertStickyComment } from '../src/action/comment.ts';
import { COMMENT_MARKER, CONFIG_NOTE, renderComment, renderNoDriftComment, type RenderContext } from '../src/action/render.ts';
import { HEAD_SHA, checkResult, fakeClient, finding } from './helpers/action-fakes.ts';

const ctx: RenderContext = { serverUrl: 'https://github.com', owner: 'acme', repo: 'widgets', headSha: HEAD_SHA };
const bot = { type: 'Bot', login: 'github-actions[bot]' };
const result = checkResult([finding()]);

describe('upsertStickyComment', () => {
  it('creates the comment when there is none', async () => {
    const client = fakeClient([{ id: 1, body: 'LGTM', user: { type: 'User', login: 'alice' } }]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('created');
    expect(client.calls).toEqual(['list #7', 'create #7']);
    expect(client.comments.at(-1)?.body).toBe(renderComment(result, ctx));
  });

  it('updates the existing sticky comment instead of adding another', async () => {
    const client = fakeClient([
      { id: 1, body: 'LGTM', user: { type: 'User', login: 'alice' } },
      { id: 2, body: `${COMMENT_MARKER}\nold`, user: bot },
    ]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('updated');
    expect(client.calls).toEqual(['list #7', 'update 2']);
    expect(client.comments).toHaveLength(2);
    expect(client.comments[1]?.body).toBe(renderComment(result, ctx));
  });

  it('updates the oldest sticky comment when there are several', async () => {
    const client = fakeClient([
      { id: 5, body: `${COMMENT_MARKER}\nfirst`, user: bot },
      { id: 6, body: `${COMMENT_MARKER}\nsecond`, user: bot },
    ]);
    await upsertStickyComment(client, 7, result, ctx);
    expect(client.calls).toEqual(['list #7', 'update 5']);
  });

  it('does not touch an identical comment', async () => {
    const client = fakeClient([{ id: 2, body: renderComment(result, ctx), user: bot }]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('unchanged');
    expect(client.calls).toEqual(['list #7']);
  });

  it('ignores a marker quoted in a comment written by a person', async () => {
    const client = fakeClient([{ id: 3, body: `${COMMENT_MARKER}\nfake`, user: { type: 'User', login: 'mallory' } }]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('created');
    expect(client.calls).toEqual(['list #7', 'create #7']);
  });

  it('ignores a marker comment of another bot: only github-actions[bot] or the authenticated login own it', async () => {
    const client = fakeClient([
      { id: 3, body: `${COMMENT_MARKER}\nfake`, user: { type: 'Bot', login: 'dependabot[bot]' } },
      { id: 4, body: `${COMMENT_MARKER}\nfake`, user: { type: 'Bot' } },
    ]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('created');
    expect(client.calls).toEqual(['list #7', 'create #7']);
  });

  it('recognises the comment of the authenticated user (a PAT or app token) as its own', async () => {
    const client = fakeClient([{ id: 3, body: `${COMMENT_MARKER}\nold`, user: { type: 'User', login: 'drift-bot' } }]);
    client.viewer = 'drift-bot';
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('updated');
    expect(client.calls).toEqual(['list #7', 'update 3']);
  });

  it('does not take another user for the authenticated one', async () => {
    const client = fakeClient([{ id: 3, body: `${COMMENT_MARKER}\nfake`, user: { type: 'User', login: 'mallory' } }]);
    client.viewer = 'drift-bot';
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('created');
  });

  it('ignores a bot comment that does not carry the marker, and one without an author', async () => {
    const client = fakeClient([
      { id: 3, body: 'Coverage report', user: bot },
      { id: 4, body: `${COMMENT_MARKER}\nghost` },
    ]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('created');
  });

  it('only recognises the marker as the first line', async () => {
    const client = fakeClient([{ id: 3, body: `quoting\n${COMMENT_MARKER}`, user: bot }]);
    await expect(upsertStickyComment(client, 7, result, ctx)).resolves.toBe('created');
  });

  it('turns an existing comment into "no drift" when the findings are gone', async () => {
    const client = fakeClient([{ id: 2, body: renderComment(result, ctx), user: bot }]);
    await expect(upsertStickyComment(client, 7, checkResult([]), ctx)).resolves.toBe('updated');
    expect(client.comments[0]?.body).toBe(renderNoDriftComment(ctx));
    expect(client.calls).toEqual(['list #7', 'update 2']);
  });

  it('leaves an already-"no drift" comment alone', async () => {
    const client = fakeClient([{ id: 2, body: renderNoDriftComment(ctx), user: bot }]);
    await expect(upsertStickyComment(client, 7, checkResult([]), ctx)).resolves.toBe('unchanged');
    expect(client.calls).toEqual(['list #7']);
  });

  it('puts the config-changed note into a created and a no-drift comment', async () => {
    const changed = checkResult([finding()], { configChanged: true });
    const client = fakeClient();
    await upsertStickyComment(client, 7, changed, ctx);
    expect(client.comments[0]?.body).toContain(CONFIG_NOTE);
    const clean = fakeClient([{ id: 2, body: renderComment(changed, ctx), user: bot }]);
    await upsertStickyComment(clean, 7, checkResult([], { configChanged: true }), ctx);
    expect(clean.comments[0]?.body).toContain(CONFIG_NOTE);
  });

  it('posts nothing when there is no drift and no earlier comment', async () => {
    const client = fakeClient();
    await expect(upsertStickyComment(client, 7, checkResult([]), ctx)).resolves.toBe('none');
    expect(client.calls).toEqual(['list #7']);
  });
});
