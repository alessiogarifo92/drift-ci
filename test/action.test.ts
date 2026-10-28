import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction, type ActionDeps } from "../src/action/main.ts";
import { GitHubApiError } from "../src/action/github.ts";
import { COMMENT_MARKER } from "../src/action/render.ts";
import { ConfigError } from "../src/core/config.ts";
import type { CheckResult } from "../src/core/finding.ts";
import { GitError } from "../src/git/errors.ts";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  checkResult,
  eventFile,
  fakeClient,
  fakeCore,
  fakeGit,
  finding,
  pullRequestPayload,
  type EventFile,
  type FakeClient,
  type PullRequestPayloadOptions,
} from "./helpers/action-fakes.ts";

const MERGE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PARENT_1 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface Harness {
  core: ReturnType<typeof fakeCore>;
  client: FakeClient;
  check: ReturnType<typeof vi.fn<NonNullable<ActionDeps["check"]>>>;
  createClient: ReturnType<
    typeof vi.fn<NonNullable<ActionDeps["createClient"]>>
  >;
  run: () => Promise<void>;
  events: EventFile;
}

function harness(
  options: {
    result?: CheckResult | Error;
    payload?: PullRequestPayloadOptions;
    inputs?: Record<string, string>;
    eventName?: string;
    env?: NodeJS.ProcessEnv;
    client?: FakeClient;
  } = {},
): Harness {
  const events = eventFile(
    pullRequestPayload(options.payload),
    options.env,
    options.eventName,
  );
  cleanups.push(events.cleanup);
  const core = fakeCore(options.inputs);
  const client = options.client ?? fakeClient();
  const outcome = options.result ?? checkResult([finding()]);
  const check = vi.fn<NonNullable<ActionDeps["check"]>>(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const createClient = vi.fn<NonNullable<ActionDeps["createClient"]>>(
    () => client,
  );
  const git = fakeGit({
    "rev-list --parents -n1 HEAD": `${MERGE} ${PARENT_1} ${HEAD_SHA}`,
  });
  return {
    core,
    client,
    check,
    createClient,
    events,
    run: () => runAction({ core, env: events.env, git, check, createClient }),
  };
}

describe("runAction: events", () => {
  it("does nothing, successfully, on events other than pull_request", async () => {
    const h = harness({ eventName: "push" });
    await h.run();
    expect(h.core.infos).toEqual([
      "drift-ci only runs on pull_request events (this is a push event); nothing to do",
    ]);
    expect(h.core.failures).toEqual([]);
    expect(h.check).not.toHaveBeenCalled();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.core.summaries).toEqual([]);
  });

  it("warns on pull_request_target but still checks", async () => {
    const h = harness({ eventName: "pull_request_target" });
    await h.run();
    expect(h.core.annotations[0]).toMatchObject({ level: "warning" });
    expect(h.core.annotations[0]?.message).toMatch(/pull_request_target/);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("fails with the reason when the environment is incomplete", async () => {
    const h = harness({ env: { GITHUB_WORKSPACE: undefined } });
    await h.run();
    expect(h.core.failures).toEqual([
      expect.stringMatching(/GITHUB_WORKSPACE/),
    ]);
  });

  it("fails on an invalid input", async () => {
    const h = harness({ inputs: { "fail-on": "sometimes" } });
    await h.run();
    expect(h.core.failures).toEqual([expect.stringMatching(/fail-on/)]);
    expect(h.check).not.toHaveBeenCalled();
  });
});

describe("runAction: reporting", () => {
  it("checks base..merge commit and reports through annotations, summary and a comment", async () => {
    const h = harness();
    await h.run();

    expect(h.check).toHaveBeenCalledWith("/work", PARENT_1, MERGE, {
      configFrom: "base",
      repo: { owner: "acme", name: "widgets" },
    });
    expect(h.createClient).toHaveBeenCalledWith({
      token: "tok",
      apiUrl: "https://api.github.com",
      owner: "acme",
      repo: "widgets",
    });
    expect(h.core.annotations).toHaveLength(1);
    expect(h.core.summaries).toHaveLength(1);
    expect(h.core.summaries[0]).toContain("README.md:3");
    expect(h.client.comments).toHaveLength(1);
    expect(h.client.comments[0]?.body).toContain(COMMENT_MARKER);
    expect(h.client.comments[0]?.body).toContain(
      `/acme/widgets/blob/${HEAD_SHA}/README.md?plain=1#L3`,
    );
    expect(h.core.failures).toEqual([]);
  });

  it("tells the check the default branch so links to it count as live", async () => {
    const h = harness();
    const payload = {
      ...(pullRequestPayload() as object),
      repository: { default_branch: "trunk" },
    };
    const events = eventFile(payload);
    cleanups.push(events.cleanup);
    await runAction({
      core: h.core,
      env: events.env,
      git: fakeGit({
        "rev-list --parents -n1 HEAD": `${MERGE} ${PARENT_1} ${HEAD_SHA}`,
      }),
      check: h.check,
      createClient: h.createClient,
    });
    expect(h.check).toHaveBeenCalledWith("/work", PARENT_1, MERGE, {
      configFrom: "base",
      repo: { owner: "acme", name: "widgets", defaultBranch: "trunk" },
    });
  });

  it("logs the warnings of the check and lists them in the summary, without spending annotations on them", async () => {
    const h = harness({
      result: checkResult([finding()], {
        warnings: ["could not parse package.json"],
      }),
    });
    await h.run();
    expect(h.core.infos).toContain("warning: could not parse package.json");
    expect(h.core.annotations.map((a) => a.message)).toEqual([
      "path `src/old.ts` was renamed to `lib/new.ts` in this change (suggestion: lib/new.ts)",
    ]);
    expect(h.core.summaries[0]).toContain("could not parse package.json");
  });

  it("still emits ten finding annotations when the check also has warnings", async () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      finding({ line: i + 1 }),
    );
    const h = harness({
      result: checkResult(findings, { warnings: ["w1", "w2", "w3"] }),
    });
    await h.run();
    expect(
      h.core.annotations.filter((a) => a.level === "warning"),
    ).toHaveLength(10);
  });

  it("notes in the summary and the comment that the pull request changes .drift-ci.yml", async () => {
    const h = harness({
      result: checkResult([finding()], { configChanged: true }),
    });
    await h.run();
    expect(h.core.summaries[0]).toContain(
      "the check used the base branch configuration",
    );
    expect(h.client.comments[0]?.body).toContain(
      "the check used the base branch configuration",
    );
  });

  it('writes a "no drift" summary and no comment when nothing drifted', async () => {
    const h = harness({ result: checkResult([]) });
    await h.run();
    expect(h.core.summaries[0]).toContain("No drift found");
    expect(h.client.comments).toEqual([]);
    expect(h.core.failures).toEqual([]);
  });

  it("updates the sticky comment on a second run instead of adding one", async () => {
    const client = fakeClient();
    await harness({ client }).run();
    await harness({
      client,
      result: checkResult([finding({ line: 5 })]),
    }).run();
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]?.body).toContain("README.md?plain=1#L5");
    expect(client.calls).toEqual([
      "list #7",
      "create #7",
      "list #7",
      "update 1000",
    ]);
  });

  it("skips the comment with comment: false", async () => {
    const h = harness({ inputs: { comment: "false" } });
    await h.run();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.core.annotations).toHaveLength(1);
    expect(h.core.summaries).toHaveLength(1);
    expect(h.core.failures).toEqual([]);
  });

  it("warns and skips the comment when there is no token", async () => {
    const h = harness({ inputs: { "github-token": "" } });
    await h.run();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.core.annotations.map((a) => a.message).join("\n")).toMatch(
      /github-token/,
    );
    expect(h.core.failures).toEqual([]);
  });

  it("warns that the `config` input is reserved, unless it names the default file", async () => {
    const custom = harness({ inputs: { config: "ci/drift.yml" } });
    await custom.run();
    expect(custom.core.annotations.map((a) => a.message).join("\n")).toMatch(
      /`config` is reserved/,
    );
    expect(custom.core.failures).toEqual([]);

    const same = harness({ inputs: { config: ".drift-ci.yml" } });
    await same.run();
    expect(
      same.core.annotations.filter((a) => /config/.test(a.message)),
    ).toEqual([]);
  });

  it("survives a job summary that cannot be written", async () => {
    const h = harness();
    h.core.summaryError = new Error("GITHUB_STEP_SUMMARY is not set");
    await h.run();
    expect(h.core.annotations.map((a) => a.message).join("\n")).toMatch(
      /job summary.*GITHUB_STEP_SUMMARY/,
    );
    expect(h.core.failures).toEqual([]);
    expect(h.client.comments).toHaveLength(1);
  });
});

describe("runAction: fork pull requests and missing permissions", () => {
  it("posts no comment for a fork PR, says so in the summary, and does not fail", async () => {
    const h = harness({ payload: { headRepo: "mallory/widgets" } });
    await h.run();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.client.calls).toEqual([]);
    expect(h.core.annotations).toHaveLength(1);
    expect(h.core.summaries[0]).toContain("README.md:3");
    expect(h.core.summaries[0]).toMatch(/fork/i);
    expect(h.core.failures).toEqual([]);
  });

  it.each([403, 404])(
    "falls back to summary and annotations on a %i, with a warning",
    async (status) => {
      const client = fakeClient();
      client.failures.list = new GitHubApiError(
        status,
        "Resource not accessible by integration",
      );
      const h = harness({ client });
      await h.run();
      expect(h.core.failures).toEqual([]);
      expect(h.core.annotations).toHaveLength(2);
      expect(h.core.annotations[1]).toMatchObject({ level: "warning" });
      expect(h.core.annotations[1]?.message).toMatch(/pull-requests: write/);
      expect(h.core.summaries[0]).toMatch(/pull-requests: write/);
    },
  );

  it("falls back the same way when creating the comment is refused", async () => {
    const client = fakeClient();
    client.failures.create = new GitHubApiError(
      403,
      "Resource not accessible by integration",
    );
    const h = harness({ client });
    await h.run();
    expect(h.core.failures).toEqual([]);
    expect(h.core.summaries[0]).toMatch(/pull-requests: write/);
  });

  it("writes the summary first and then fails the job on other API errors", async () => {
    const client = fakeClient();
    client.failures.list = new GitHubApiError(500, "Server Error");
    const h = harness({ client });
    await h.run();
    expect(h.core.summaries).toHaveLength(1);
    expect(h.core.failures).toEqual([expect.stringMatching(/500/)]);
  });

  it("fails the job on a network error while commenting", async () => {
    const client = fakeClient();
    client.failures.update = new TypeError("fetch failed");
    client.comments.push({
      id: 9,
      body: `${COMMENT_MARKER}\nold`,
      user: { type: "Bot", login: "github-actions[bot]" },
    });
    const h = harness({ client });
    await h.run();
    expect(h.core.failures).toEqual([expect.stringMatching(/fetch failed/)]);
  });
});

describe("runAction: failOn", () => {
  const failing = checkResult([finding(), finding({ line: 4 })], {
    failOn: "warning",
  });

  it("fails when the config says warning and there are findings", async () => {
    const h = harness({ result: failing });
    await h.run();
    expect(h.core.failures).toEqual([
      "drift-ci found 2 drifted doc references (failOn: warning)",
    ]);
    expect(h.client.comments).toHaveLength(1);
  });

  it("uses the singular for one finding", async () => {
    const h = harness({
      result: checkResult([finding()], { failOn: "warning" }),
    });
    await h.run();
    expect(h.core.failures).toEqual([
      "drift-ci found 1 drifted doc reference (failOn: warning)",
    ]);
  });

  it("does not fail without findings", async () => {
    const h = harness({ result: checkResult([], { failOn: "warning" }) });
    await h.run();
    expect(h.core.failures).toEqual([]);
  });

  it("does not fail by default (failOn none)", async () => {
    const h = harness({ result: checkResult([finding()]) });
    await h.run();
    expect(h.core.failures).toEqual([]);
  });

  it("lets the fail-on input override the config in both directions", async () => {
    const off = harness({ result: failing, inputs: { "fail-on": "none" } });
    await off.run();
    expect(off.core.failures).toEqual([]);

    const on = harness({
      result: checkResult([finding()], { failOn: "none" }),
      inputs: { "fail-on": "warning" },
    });
    await on.run();
    expect(on.core.failures).toHaveLength(1);
  });
});

describe("runAction: errors", () => {
  it("fails with the message of a ConfigError", async () => {
    const h = harness({
      result: new ConfigError('.drift-ci.yml: unknown key "foo"'),
    });
    await h.run();
    expect(h.core.failures).toEqual(['.drift-ci.yml: unknown key "foo"']);
    expect(h.client.calls).toEqual([]);
  });

  it("fails with the first line of a GitError", async () => {
    const h = harness({
      result: new GitError("git diff failed with exit code 128\nmore detail"),
    });
    await h.run();
    expect(h.core.failures).toEqual(["git diff failed with exit code 128"]);
  });

  it("fails when the base cannot be resolved", async () => {
    const h = harness();
    const core = h.core;
    await runAction({
      core,
      env: h.events.env,
      git: fakeGit({
        "rev-list --parents -n1 HEAD": `${HEAD_SHA} ${PARENT_1}`,
        [`fetch --no-tags origin ${BASE_SHA}`]: new Error("network down"),
      }),
      check: h.check,
      createClient: h.createClient,
    });
    expect(core.failures).toEqual([
      expect.stringMatching(/could not fetch the base commit.*network down/s),
    ]);
    expect(h.check).not.toHaveBeenCalled();
  });

  it("reports a thrown non-Error value", async () => {
    const h = harness();
    h.check.mockRejectedValueOnce("boom");
    await h.run();
    expect(h.core.failures).toEqual(["boom"]);
  });
});

describe("runAction: real repositories", () => {
  function realRun(
    workspace: string,
    payload: PullRequestPayloadOptions,
    client: FakeClient,
  ) {
    const events = eventFile(pullRequestPayload(payload), {
      GITHUB_WORKSPACE: workspace,
    });
    cleanups.push(events.cleanup);
    const core = fakeCore();
    return {
      core,
      run: () =>
        runAction({ core, env: events.env, createClient: () => client }),
    };
  }

  function fixture(): FixtureRepo {
    const repo = createFixtureRepo("path-renamed-file");
    cleanups.push(repo.cleanup);
    return repo;
  }

  it("on a merge commit (the pull_request checkout): finds the drift and comments with a permalink", async () => {
    const repo = fixture();
    repo.git("checkout", "--quiet", "-b", "pr-merge", repo.baseSha);
    repo.git(
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "Merge pull request",
      repo.headSha,
    );
    const client = fakeClient();
    const { core, run } = realRun(
      repo.dir,
      { headSha: repo.headSha, baseSha: repo.baseSha },
      client,
    );

    await run();

    expect(core.failures).toEqual([]);
    expect(client.comments).toHaveLength(1);
    const body = client.comments[0]?.body ?? "";
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain(
      `](https://github.com/acme/widgets/blob/${repo.headSha}/README.md?plain=1#L3)`,
    );
    expect(body).toContain("src/old.ts");
    expect(body).toContain("Suggestion: `lib/new.ts`");
    expect(core.annotations).toMatchObject([
      {
        level: "warning",
        properties: { file: "README.md", startLine: 3, startColumn: 15 },
      },
    ]);
    console.log(`\n--- sample sticky comment ---\n${body}--- end ---`);
  });

  it("on a shallow checkout of the PR head: fetches the base, deepens, and finds the same drift", async () => {
    const origin = fixture();
    const parent = mkdtempSync(join(tmpdir(), "drift-clone-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const clone = join(parent, "checkout");
    execFileSync(
      "git",
      ["clone", "--quiet", "--depth=1", `file://${origin.dir}`, clone],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdio: "ignore",
      },
    );
    const client = fakeClient();
    const { core, run } = realRun(
      clone,
      { headSha: origin.headSha, baseSha: origin.baseSha },
      client,
    );

    await run();

    expect(core.failures).toEqual([]);
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]?.body).toContain("README.md?plain=1#L3");
  });

  it("on a depth-1 checkout of the merge commit (actions/checkout default): HEAD is not head.sha, the base is its first parent", async () => {
    const origin = fixture();
    origin.git("checkout", "--quiet", "-b", "pr-merge", origin.baseSha);
    origin.git(
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "Merge pull request",
      origin.headSha,
    );
    const mergeSha = origin.git("rev-parse", "HEAD");
    expect(mergeSha).not.toBe(origin.headSha);
    const parent = mkdtempSync(join(tmpdir(), "drift-clone-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const clone = join(parent, "checkout");
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--depth=1",
        "--branch",
        "pr-merge",
        `file://${origin.dir}`,
        clone,
      ],
      {
        env: gitEnv,
        stdio: "ignore",
      },
    );
    // The clone really is shallow: the merge commit has no parents there.
    expect(
      execFileSync("git", ["rev-list", "--parents", "-n1", "HEAD"], {
        cwd: clone,
        env: gitEnv,
        encoding: "utf8",
      }).trim(),
    ).toBe(mergeSha);
    const client = fakeClient();
    const { core, run } = realRun(
      clone,
      { headSha: origin.headSha, baseSha: origin.baseSha },
      client,
    );

    await run();

    expect(core.failures).toEqual([]);
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]?.body).toContain("README.md?plain=1#L3");
    expect(client.comments[0]?.body).toContain("Suggestion: `lib/new.ts`");
  });

  it("fails clearly when the base commit does not exist anywhere", async () => {
    const repo = fixture();
    const { core, run } = realRun(
      repo.dir,
      { headSha: repo.headSha, baseSha: BASE_SHA },
      fakeClient(),
    );
    await run();
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toMatch(/could not fetch the base commit 2222222/);
  });
});
