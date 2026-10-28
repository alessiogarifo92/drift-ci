import { afterAll, describe, expect, it } from "vitest";
import { ConfigError } from "../src/core/config.ts";
import { runDiffCheck } from "../src/git/pipeline.ts";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

const repos: FixtureRepo[] = [];
afterAll(() => repos.forEach((repo) => repo.cleanup()));
function repoFor(name: string): FixtureRepo {
  const repo = createFixtureRepo(name);
  repos.push(repo);
  return repo;
}

describe("runDiffCheck configFrom", () => {
  it("applies the head config by default (the CLI)", async () => {
    const repo = repoFor("config-disabled-paths");
    const result = await runDiffCheck(repo.dir, repo.baseSha, "HEAD");
    expect(result.findings).toEqual([]);
    expect(result.configChanged).toBe(true);
  });

  it("with configFrom base, a head config that disables a check does not apply (the Action)", async () => {
    const repo = repoFor("config-disabled-paths");
    const result = await runDiffCheck(repo.dir, repo.baseSha, "HEAD", {
      configFrom: "base",
    });
    expect(result.findings.map((f) => f.ruleId)).toEqual(["path"]);
    expect(result.configChanged).toBe(true);
  });

  it("with configFrom base, an invalid head config is not read", async () => {
    const repo = repoFor("config-invalid");
    await expect(
      runDiffCheck(repo.dir, repo.baseSha, "HEAD"),
    ).rejects.toBeInstanceOf(ConfigError);
    const result = await runDiffCheck(repo.dir, repo.baseSha, "HEAD", {
      configFrom: "base",
    });
    expect(result.findings).toHaveLength(1);
  });

  it("with configFrom base, an invalid base config is an error", async () => {
    const repo = repoFor("config-invalid");
    await expect(
      runDiffCheck(repo.dir, "HEAD", "HEAD", { configFrom: "base" }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
