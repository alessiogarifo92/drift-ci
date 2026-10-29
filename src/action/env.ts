// What the runner tells the Action: GITHUB_* variables, the event payload and the inputs.
import { readFileSync } from "node:fs";
import type { FailOn } from "../core/finding.ts";
import { ActionError, errorMessage } from "./errors.ts";

export interface PullRequestContext {
  number: number;
  /** `pull_request.head.sha`: the commit the permalinks point at. */
  headSha: string;
  /** `pull_request.base.sha`: the tip of the base branch when the event fired. */
  baseSha: string;
  /** The head lives in another repository (or its repository is gone): the token is read-only. */
  isFork: boolean;
}

export type ActionEvent =
  | {
      kind: "pull_request";
      eventName: "pull_request" | "pull_request_target";
      pr: PullRequestContext;
    }
  | { kind: "unsupported"; eventName: string };

export interface ActionEnv {
  workspace: string;
  owner: string;
  repo: string;
  /** The repository's default branch, when the event carries it. */
  defaultBranch?: string;
  serverUrl: string;
  apiUrl: string;
  event: ActionEvent;
}

export interface ActionInputs {
  /** Reserved: `.drift-ci.yml` at the root is the only config the core reads. */
  config: string | undefined;
  /** `undefined` = use the config's `failOn`. */
  failOn: FailOn | undefined;
  comment: boolean;
  token: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value)
    throw new ActionError(
      `${name} is not set: drift-ci must run inside a GitHub Actions job`,
    );
  return value;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readPayload(path: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ActionError(
      `cannot read the event payload at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return record(parsed) ?? {};
}

function readPullRequest(payload: Json): PullRequestContext {
  const pr = record(payload["pull_request"]);
  if (!pr)
    throw new ActionError(
      "the event payload has no pull_request: is this a pull_request event?",
    );
  const head = record(pr["head"]);
  const base = record(pr["base"]);
  const number = pr["number"];
  const headSha = string(head?.["sha"]);
  const baseSha = string(base?.["sha"]);
  if (typeof number !== "number")
    throw new ActionError("the event payload has no pull_request.number");
  if (!headSha)
    throw new ActionError("the event payload has no pull_request.head.sha");
  if (!baseSha)
    throw new ActionError("the event payload has no pull_request.base.sha");
  const headRepo = string(record(head?.["repo"])?.["full_name"]);
  const baseRepo = string(record(base?.["repo"])?.["full_name"]);
  const isFork =
    !headRepo || !baseRepo || headRepo.toLowerCase() !== baseRepo.toLowerCase();
  return { number, headSha, baseSha, isFork };
}

/** Reads the job's environment. Throws ActionError when it is not a GitHub Actions job. */
export function readEnv(env: NodeJS.ProcessEnv): ActionEnv {
  const eventName = required(env, "GITHUB_EVENT_NAME");
  const workspace = required(env, "GITHUB_WORKSPACE");
  const repository = required(env, "GITHUB_REPOSITORY");
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new ActionError(`GITHUB_REPOSITORY is not owner/name: ${repository}`);
  }
  const common = {
    workspace,
    owner,
    repo: name,
    serverUrl: stripTrailingSlashes(
      env["GITHUB_SERVER_URL"] || "https://github.com",
    ),
    apiUrl: stripTrailingSlashes(
      env["GITHUB_API_URL"] || "https://api.github.com",
    ),
  };

  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    return { ...common, event: { kind: "unsupported", eventName } };
  }
  const payload = readPayload(required(env, "GITHUB_EVENT_PATH"));
  const defaultBranch = string(
    record(payload["repository"])?.["default_branch"],
  );
  return {
    ...common,
    ...(defaultBranch ? { defaultBranch } : {}),
    event: { kind: "pull_request", eventName, pr: readPullRequest(payload) },
  };
}

/** Reads and validates the inputs declared in action.yml. */
export function readInputs(getInput: (name: string) => string): ActionInputs {
  const failOn = getInput("fail-on").trim().toLowerCase();
  if (failOn !== "" && failOn !== "none" && failOn !== "warning") {
    throw new ActionError(
      `input fail-on must be "none" or "warning", got "${failOn}"`,
    );
  }
  const comment = getInput("comment").trim().toLowerCase();
  if (comment !== "" && comment !== "true" && comment !== "false") {
    throw new ActionError(
      `input comment must be "true" or "false", got "${comment}"`,
    );
  }
  return {
    config: getInput("config").trim() || undefined,
    failOn: failOn === "" ? undefined : failOn,
    comment: comment !== "false",
    token: getInput("github-token"),
  };
}
