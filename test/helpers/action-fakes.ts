// Fakes for the Action tests: a recording `core`, an in-memory GitHub client, an event file.
import type { AnnotationProperties } from '@actions/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionCore } from '../../src/action/core.ts';
import type { GitHubClient, IssueComment } from '../../src/action/github.ts';
import type { GitRunner } from '../../src/action/base.ts';
import type { CheckResult, Finding } from '../../src/core/finding.ts';

export const HEAD_SHA = '1111111111111111111111111111111111111111';
export const BASE_SHA = '2222222222222222222222222222222222222222';

export interface Annotation {
  level: 'warning' | 'notice';
  message: string;
  properties: AnnotationProperties | undefined;
}

export interface FakeCore extends ActionCore {
  infos: string[];
  annotations: Annotation[];
  failures: string[];
  summaries: string[];
  inputs: Record<string, string>;
  /** Make `writeSummary` reject. */
  summaryError?: Error;
}

export function fakeCore(inputs: Record<string, string> = {}): FakeCore {
  const core: FakeCore = {
    infos: [],
    annotations: [],
    failures: [],
    summaries: [],
    inputs: { 'github-token': 'tok', ...inputs },
    info: (message) => void core.infos.push(message),
    warning: (message, properties) => void core.annotations.push({ level: 'warning', message, properties }),
    notice: (message, properties) => void core.annotations.push({ level: 'notice', message, properties }),
    setFailed: (message) => void core.failures.push(message),
    getInput: (name) => core.inputs[name] ?? '',
    writeSummary: async (markdown) => {
      if (core.summaryError) throw core.summaryError;
      core.summaries.push(markdown);
    },
  };
  return core;
}

export interface FakeClient extends GitHubClient {
  comments: IssueComment[];
  calls: string[];
  /** Login of the authenticated user, as `GET /user` answers; `undefined` as for a GITHUB_TOKEN (403). */
  viewer: string | undefined;
  /** Errors thrown by the named method instead of doing its work. */
  failures: Partial<Record<'list' | 'create' | 'update', Error>>;
}

export function fakeClient(comments: IssueComment[] = []): FakeClient {
  let nextId = 1000;
  const client: FakeClient = {
    comments: [...comments],
    calls: [],
    viewer: undefined,
    failures: {},
    viewerLogin: async () => client.viewer,
    listIssueComments: async (pr) => {
      client.calls.push(`list #${pr}`);
      if (client.failures.list) throw client.failures.list;
      return client.comments.map((c) => ({ ...c }));
    },
    createComment: async (pr, body) => {
      client.calls.push(`create #${pr}`);
      if (client.failures.create) throw client.failures.create;
      client.comments.push({ id: nextId++, body, user: { type: 'Bot', login: 'github-actions[bot]' } });
    },
    updateComment: async (id, body) => {
      client.calls.push(`update ${id}`);
      if (client.failures.update) throw client.failures.update;
      const comment = client.comments.find((c) => c.id === id);
      if (comment) comment.body = body;
    },
  };
  return client;
}

/** A GitRunner answering by the joined arguments; anything unlisted throws. */
export function fakeGit(
  answers: Record<string, string | Error | (() => string)>,
): GitRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner = async (args: readonly string[]): Promise<string> => {
    const key = args.join(' ');
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected git call: ${key}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  };
  return Object.assign(runner, { calls });
}

export interface PullRequestPayloadOptions {
  number?: number;
  headSha?: string;
  baseSha?: string;
  headRepo?: string | null;
  baseRepo?: string;
}

export function pullRequestPayload(options: PullRequestPayloadOptions = {}): unknown {
  const number = options.number ?? 7;
  return {
    action: 'synchronize',
    number,
    pull_request: {
      number,
      head: {
        sha: options.headSha ?? HEAD_SHA,
        repo: options.headRepo === null ? null : { full_name: options.headRepo ?? 'acme/widgets' },
      },
      base: { sha: options.baseSha ?? BASE_SHA, repo: { full_name: options.baseRepo ?? 'acme/widgets' } },
    },
  };
}

export interface EventFile {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** Writes `payload` to a temp file and returns the GITHUB_* environment pointing at it. */
export function eventFile(
  payload: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
  eventName = 'pull_request',
): EventFile {
  const dir = mkdtempSync(join(tmpdir(), 'drift-event-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return {
    env: {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: path,
      GITHUB_WORKSPACE: '/work',
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_API_URL: 'https://api.github.com',
      ...extraEnv,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A path finding on README.md:3; `suggestion: null` removes the suggestion. */
export function finding(overrides: Omit<Partial<Finding>, 'suggestion'> & { suggestion?: string | null } = {}): Finding {
  const { suggestion = 'lib/new.ts', ...rest } = overrides;
  const result: Finding = {
    ruleId: 'path',
    kind: 'path',
    fact: 'src/old.ts',
    file: 'README.md',
    line: 3,
    col: 15,
    message: 'path `src/old.ts` was renamed to `lib/new.ts` in this change',
    fingerprint: 'abcdef0123456789',
    ...rest,
  };
  if (suggestion !== null) result.suggestion = suggestion;
  return result;
}

export function checkResult(findings: Finding[] = [], overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    schemaVersion: 1,
    mode: 'diff',
    base: BASE_SHA,
    head: HEAD_SHA,
    findings,
    warnings: [],
    failOn: 'none',
    ...overrides,
  };
}
