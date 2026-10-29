import { CONFIG_PATH } from "../core/config.ts";
import type { CheckResult } from "../core/finding.ts";
import { GitError } from "../git/errors.ts";
import { runDiffCheck } from "../git/pipeline.ts";
import { emitAnnotations } from "./annotations.ts";
import { createGitRunner, resolveBase, type GitRunner } from "./base.ts";
import { upsertStickyComment } from "./comment.ts";
import { createActionCore, type ActionCore } from "./core.ts";
import {
  readEnv,
  readInputs,
  type ActionEnv,
  type ActionInputs,
  type PullRequestContext,
} from "./env.ts";
import { errorMessage } from "./errors.ts";
import {
  GitHubApiError,
  createGitHubClient,
  type GitHubClient,
  type GitHubClientOptions,
} from "./github.ts";
import { renderSummary, type RenderContext } from "./render.ts";

/** Everything the Action touches outside itself, replaceable in tests. */
export interface ActionDeps {
  core?: ActionCore;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
  check?: typeof runDiffCheck;
  createClient?: (options: GitHubClientOptions) => GitHubClient;
}

const FORK_NOTE =
  "This pull request comes from a fork, where the token is read-only: no PR comment was posted. The findings are in this summary and in the annotations.";
const NO_PERMISSION_NOTE =
  "The PR comment was not posted: the token cannot write to pull requests. Grant the job `pull-requests: write` to get it. The findings are in this summary and in the annotations.";

/**
 * Action entry point. Never rejects: every failure becomes `core.setFailed`, except a pull request
 * that cannot be commented on (fork, no `pull-requests: write`), which only loses the comment.
 */
export async function runAction(deps: ActionDeps = {}): Promise<void> {
  const core = deps.core ?? createActionCore();
  try {
    await run(core, deps);
  } catch (error) {
    // The first line of a git failure names the command; the rest is git's own noise.
    core.setFailed(
      error instanceof GitError
        ? (errorMessage(error).split("\n")[0] ?? "")
        : errorMessage(error),
    );
  }
}

async function run(core: ActionCore, deps: ActionDeps): Promise<void> {
  const inputs = readInputs((name) => core.getInput(name));
  const env = readEnv(deps.env ?? process.env);
  if (env.event.kind === "unsupported") {
    core.info(
      `drift-ci only runs on pull_request events (this is a ${env.event.eventName} event); nothing to do`,
    );
    return;
  }
  const { eventName, pr } = env.event;
  if (eventName === "pull_request_target") {
    core.warning(
      "drift-ci is meant for pull_request events: pull_request_target runs with the base repository token and, by default, a checkout of the base branch.",
    );
  }
  if (inputs.config !== undefined && inputs.config !== CONFIG_PATH) {
    core.warning(
      `input \`config\` is reserved and ignored: drift-ci reads ${CONFIG_PATH} at the repository root only`,
    );
  }

  const git = deps.git ?? createGitRunner(env.workspace);
  const { base, head } = await resolveBase(git, {
    headSha: pr.headSha,
    baseSha: pr.baseSha,
  });
  const check = deps.check ?? runDiffCheck;
  const result = await check(env.workspace, base, head, {
    configFrom: "base",
    repo: {
      owner: env.owner,
      name: env.repo,
      ...(env.defaultBranch ? { defaultBranch: env.defaultBranch } : {}),
    },
  });

  // Not annotations: GitHub shows ten per step and the findings need them. The summary lists the warnings too.
  for (const warning of result.warnings) core.info(`warning: ${warning}`);
  emitAnnotations(core, result.findings);

  const ctx: RenderContext = {
    serverUrl: env.serverUrl,
    owner: env.owner,
    repo: env.repo,
    headSha: pr.headSha,
  };
  const notes: string[] = [];
  let commentFailure: unknown;
  try {
    await postComment(core, deps, env, inputs, pr, result, ctx, notes);
  } catch (error) {
    commentFailure = error;
  }

  try {
    await core.writeSummary(renderSummary(result, ctx, notes));
  } catch (error) {
    core.warning(`could not write the job summary: ${errorMessage(error)}`);
  }
  if (commentFailure !== undefined) {
    throw new Error(
      `could not post the PR comment: ${errorMessage(commentFailure)}`,
      { cause: commentFailure },
    );
  }

  const failOn = inputs.failOn ?? result.failOn;
  const count = result.findings.length;
  if (failOn === "warning" && count > 0) {
    core.setFailed(
      `drift-ci found ${count} drifted doc reference${count === 1 ? "" : "s"} (failOn: warning)`,
    );
  }
}

/** Upserts the sticky comment, or records in `notes` why not. Throws only on unexpected API failures. */
async function postComment(
  core: ActionCore,
  deps: ActionDeps,
  env: ActionEnv,
  inputs: ActionInputs,
  pr: PullRequestContext,
  result: CheckResult,
  ctx: RenderContext,
  notes: string[],
): Promise<void> {
  if (!inputs.comment) return;
  if (pr.isFork) {
    core.info("pull request from a fork: skipping the PR comment");
    notes.push(FORK_NOTE);
    return;
  }
  if (!inputs.token) {
    core.warning("input `github-token` is empty: skipping the PR comment");
    notes.push("The PR comment was not posted: no GitHub token.");
    return;
  }
  const client = (deps.createClient ?? createGitHubClient)({
    token: inputs.token,
    apiUrl: env.apiUrl,
    owner: env.owner,
    repo: env.repo,
  });
  try {
    const outcome = await upsertStickyComment(client, pr.number, result, ctx);
    core.info(`PR comment: ${outcome}`);
  } catch (error) {
    if (
      error instanceof GitHubApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      core.warning(
        `${NO_PERMISSION_NOTE.split(" The findings")[0]} (${errorMessage(error)})`,
      );
      notes.push(NO_PERMISSION_NOTE);
      return;
    }
    throw error;
  }
}
