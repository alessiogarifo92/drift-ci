import { describe, expect, it } from 'vitest';
import { GitHubApiError, createGitHubClient } from '../src/action/github.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Call) => { status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status = 200, json, text } = respond(call);
    return new Response(text ?? JSON.stringify(json ?? {}), { status });
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

const options = { token: 'secret', apiUrl: 'https://api.github.com', owner: 'acme', repo: 'widgets' };

describe('createGitHubClient', () => {
  it('lists comments with auth headers and follows pages until a short one', async () => {
    const page = (n: number, size: number) =>
      Array.from({ length: size }, (_, i) => ({
        id: n * 1000 + i,
        body: `c${n}-${i}`,
        user: { type: 'Bot', login: 'github-actions[bot]' },
        extra: 'ignored',
      }));
    const { fetchFn, calls } = fakeFetch((call) => {
      const pageNo = Number(new URL(call.url).searchParams.get('page'));
      return { json: pageNo === 1 ? page(1, 100) : page(2, 3) };
    });
    const comments = await createGitHubClient({ ...options, fetchFn }).listIssueComments(7);

    expect(comments).toHaveLength(103);
    expect(comments[0]).toEqual({ id: 1000, body: 'c1-0', user: { type: 'Bot', login: 'github-actions[bot]' } });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=1',
      'https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=2',
    ]);
    expect(calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer secret',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('omits the user of a comment that has none', async () => {
    const { fetchFn } = fakeFetch(() => ({ json: [{ id: 1, body: 'x', user: null }] }));
    const comments = await createGitHubClient({ ...options, fetchFn }).listIssueComments(1);
    expect(comments).toEqual([{ id: 1, body: 'x' }]);
  });

  it('creates a comment with a POST', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 201 }));
    await createGitHubClient({ ...options, fetchFn }).createComment(7, 'hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/widgets/issues/7/comments',
      method: 'POST',
      body: { body: 'hello' },
    });
  });

  it('updates a comment with a PATCH', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({}));
    await createGitHubClient({ ...options, fetchFn }).updateComment(55, 'edited');
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/widgets/issues/comments/55',
      method: 'PATCH',
      body: { body: 'edited' },
    });
  });

  it('throws GitHubApiError carrying the status and the API message', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 403,
      json: { message: 'Resource not accessible by integration' },
    }));
    const failure = createGitHubClient({ ...options, fetchFn }).createComment(7, 'x');
    await expect(failure).rejects.toBeInstanceOf(GitHubApiError);
    await expect(failure).rejects.toMatchObject({ status: 403 });
    await expect(failure).rejects.toThrow(/403.*Resource not accessible by integration/);
  });

  it('survives an error body that is not JSON', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 502, text: '<html>Bad gateway</html>' }));
    await expect(createGitHubClient({ ...options, fetchFn }).listIssueComments(1)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('rejects a listing that is not an array of comments', async () => {
    const { fetchFn } = fakeFetch(() => ({ json: { not: 'a list' } }));
    await expect(createGitHubClient({ ...options, fetchFn }).listIssueComments(1)).rejects.toThrow(
      /unexpected response/,
    );
  });

  it('encodes owner and repo in the URL', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ json: [] }));
    await createGitHubClient({ ...options, owner: 'a b', repo: 'c/d', fetchFn }).listIssueComments(1);
    expect(calls[0]?.url).toContain('/repos/a%20b/c%2Fd/issues/1/comments');
  });
});
