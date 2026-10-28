// The slice of the GitHub REST API the Action needs: the comments of a pull request.
export interface IssueComment {
  id: number;
  body: string;
  user?: { type?: string; login?: string };
}

export interface GitHubClient {
  listIssueComments(pr: number): Promise<IssueComment[]>;
  createComment(pr: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
  /**
   * Login of the user the token belongs to (`GET /user`), or `undefined` when the token has none to show:
   * GITHUB_TOKEN answers 403. Cached per client.
   */
  viewerLogin(): Promise<string | undefined>;
}

/** The API answered with an error status. */
export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface GitHubClientOptions {
  token: string;
  /** `GITHUB_API_URL`, without a trailing slash. */
  apiUrl: string;
  owner: string;
  repo: string;
  fetchFn?: typeof fetch;
}

const PER_PAGE = 100;

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const { token, apiUrl, fetchFn = fetch } = options;
  const repoUrl = `${apiUrl}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;

  async function request(method: string, url: string, body?: unknown): Promise<unknown> {
    const response = await fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubApiError(response.status, apiMessage(text) ?? response.statusText);
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }

  let viewer: Promise<string | undefined> | undefined;

  return {
    viewerLogin() {
      viewer ??= (async () => {
        try {
          const data = await request('GET', `${apiUrl}/user`);
          const login = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['login'] : undefined;
          return typeof login === 'string' && login !== '' ? login : undefined;
        } catch (error) {
          if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) return undefined;
          throw error;
        }
      })();
      // A failure is not remembered: the next call asks again.
      viewer.catch(() => {
        viewer = undefined;
      });
      return viewer;
    },
    async listIssueComments(pr) {
      const comments: IssueComment[] = [];
      for (let page = 1; ; page++) {
        const data = await request('GET', `${repoUrl}/issues/${pr}/comments?per_page=${PER_PAGE}&page=${page}`);
        if (!Array.isArray(data)) throw new Error('unexpected response listing the comments: not an array');
        comments.push(...data.map(toComment));
        if (data.length < PER_PAGE) return comments;
      }
    },
    async createComment(pr, body) {
      await request('POST', `${repoUrl}/issues/${pr}/comments`, { body });
    },
    async updateComment(id, body) {
      await request('PATCH', `${repoUrl}/issues/comments/${id}`, { body });
    },
  };
}

function apiMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

function toComment(raw: unknown): IssueComment {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const user = typeof item['user'] === 'object' && item['user'] !== null ? (item['user'] as Record<string, unknown>) : undefined;
  const comment: IssueComment = {
    id: Number(item['id']),
    body: typeof item['body'] === 'string' ? item['body'] : '',
  };
  if (user) {
    comment.user = {
      ...(typeof user['type'] === 'string' ? { type: user['type'] } : {}),
      ...(typeof user['login'] === 'string' ? { login: user['login'] } : {}),
    };
  }
  return comment;
}
