import { afterEach, describe, expect, it } from 'vitest';
import { ActionError } from '../src/action/errors.ts';
import { readEnv, readInputs } from '../src/action/env.ts';
import { BASE_SHA, HEAD_SHA, eventFile, pullRequestPayload, type EventFile } from './helpers/action-fakes.ts';

let current: EventFile | undefined;
afterEach(() => current?.cleanup());

function setup(payload: unknown, env: NodeJS.ProcessEnv = {}, eventName = 'pull_request'): NodeJS.ProcessEnv {
  current = eventFile(payload, env, eventName);
  return current.env;
}

describe('readEnv', () => {
  it('reads a same-repository pull_request', () => {
    const env = readEnv(setup(pullRequestPayload({ number: 12 })));
    expect(env).toEqual({
      workspace: '/work',
      owner: 'acme',
      repo: 'widgets',
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      event: {
        kind: 'pull_request',
        eventName: 'pull_request',
        pr: { number: 12, headSha: HEAD_SHA, baseSha: BASE_SHA, isFork: false },
      },
    });
  });

  it('flags a pull request from a fork, whatever the case of the repository names', () => {
    const fork = readEnv(setup(pullRequestPayload({ headRepo: 'someone/widgets' })));
    expect(fork.event).toMatchObject({ kind: 'pull_request', pr: { isFork: true } });
    current?.cleanup();
    const sameRepo = readEnv(setup(pullRequestPayload({ headRepo: 'ACME/Widgets' })));
    expect(sameRepo.event).toMatchObject({ pr: { isFork: false } });
  });

  it('treats a PR whose head repository was deleted as a fork', () => {
    const env = readEnv(setup(pullRequestPayload({ headRepo: null })));
    expect(env.event).toMatchObject({ pr: { isFork: true } });
  });

  it('accepts pull_request_target and keeps its event name', () => {
    const env = readEnv(setup(pullRequestPayload(), {}, 'pull_request_target'));
    expect(env.event).toMatchObject({ kind: 'pull_request', eventName: 'pull_request_target' });
  });

  it('reports other events as unsupported without reading the payload', () => {
    const env = readEnv({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_WORKSPACE: '/work',
      GITHUB_REPOSITORY: 'acme/widgets',
    });
    expect(env.event).toEqual({ kind: 'unsupported', eventName: 'push' });
  });

  it('passes on the default branch when the event carries it', () => {
    const payload = { ...(pullRequestPayload() as object), repository: { default_branch: 'trunk' } };
    expect(readEnv(setup(payload))).toMatchObject({ defaultBranch: 'trunk' });
    current?.cleanup();
    expect(readEnv(setup(pullRequestPayload()))).not.toHaveProperty('defaultBranch');
  });

  it('defaults the server and API URLs to github.com', () => {
    const env = readEnv(
      setup(pullRequestPayload(), { GITHUB_SERVER_URL: undefined, GITHUB_API_URL: undefined }),
    );
    expect(env.serverUrl).toBe('https://github.com');
    expect(env.apiUrl).toBe('https://api.github.com');
  });

  it('strips trailing slashes from the URLs (GitHub Enterprise Server)', () => {
    const env = readEnv(
      setup(pullRequestPayload(), {
        GITHUB_SERVER_URL: 'https://ghe.example.com/',
        GITHUB_API_URL: 'https://ghe.example.com/api/v3/',
      }),
    );
    expect(env.serverUrl).toBe('https://ghe.example.com');
    expect(env.apiUrl).toBe('https://ghe.example.com/api/v3');
  });

  it.each(['GITHUB_EVENT_NAME', 'GITHUB_WORKSPACE', 'GITHUB_REPOSITORY'])('fails when %s is missing', (name) => {
    const env = setup(pullRequestPayload(), { [name]: undefined });
    expect(() => readEnv(env)).toThrow(ActionError);
    expect(() => readEnv(env)).toThrow(new RegExp(name));
  });

  it('fails on a malformed GITHUB_REPOSITORY', () => {
    expect(() => readEnv(setup(pullRequestPayload(), { GITHUB_REPOSITORY: 'nope' }))).toThrow(
      /GITHUB_REPOSITORY/,
    );
  });

  it('fails when GITHUB_EVENT_PATH is missing or unreadable', () => {
    expect(() => readEnv(setup(pullRequestPayload(), { GITHUB_EVENT_PATH: undefined }))).toThrow(
      /GITHUB_EVENT_PATH/,
    );
    expect(() => readEnv(setup(pullRequestPayload(), { GITHUB_EVENT_PATH: '/nonexistent/event.json' }))).toThrow(
      /event payload/,
    );
  });

  it('fails when the payload is not a pull request payload', () => {
    expect(() => readEnv(setup({ action: 'opened' }))).toThrow(/pull_request/);
    current?.cleanup();
    expect(() => readEnv(setup({ pull_request: { number: 1, head: {}, base: {} } }))).toThrow(/head\.sha/);
  });
});

describe('readInputs', () => {
  const inputs = (values: Record<string, string>) => readInputs((name) => values[name] ?? '');

  it('has defaults: config from the file, no failOn override, comment on', () => {
    expect(inputs({ 'github-token': 't' })).toEqual({
      config: undefined,
      failOn: undefined,
      comment: true,
      token: 't',
    });
  });

  it('parses the explicit values', () => {
    expect(
      inputs({ config: 'ci/drift.yml', 'fail-on': 'warning', comment: 'false', 'github-token': 't' }),
    ).toEqual({ config: 'ci/drift.yml', failOn: 'warning', comment: false, token: 't' });
    expect(inputs({ 'fail-on': 'none', comment: 'TRUE' })).toMatchObject({ failOn: 'none', comment: true });
  });

  it('rejects an unknown fail-on or comment value', () => {
    expect(() => inputs({ 'fail-on': 'error' })).toThrow(/fail-on/);
    expect(() => inputs({ comment: 'maybe' })).toThrow(/comment/);
  });
});
