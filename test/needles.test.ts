import { describe, expect, it } from "vitest";
import { needlesOf, runCheck } from "../src/core/check.ts";
import { mentionsAny } from "../src/core/collect.ts";
import { binRule } from "../src/core/rules/bin.ts";
import { envRule } from "../src/core/rules/env.ts";
import { makeTargetRule } from "../src/core/rules/make.ts";
import { pathRule } from "../src/core/rules/path.ts";
import { npmScriptRule } from "../src/core/rules/scripts.ts";
import type { CheckContext, DiffHunk, Rule } from "../src/core/rules.ts";
import type { RepoSnapshot } from "../src/core/snapshot.ts";
import { changeSet, memorySnapshot } from "./helpers/memory-snapshot.ts";
import { pkg, type Files } from "./helpers/run-rule.ts";

async function needlesAfterPrepare(
  rule: Rule,
  base: Files,
  head: Files,
  hunks: DiffHunk[] = [],
) {
  const [b, h] = [memorySnapshot(base), memorySnapshot(head)];
  const ctx: CheckContext = {
    base: b,
    head: h,
    changes: changeSet(),
    baseFiles: await b.listFiles(),
    headFiles: await h.listFiles(),
    hunks,
    warn: () => undefined,
  };
  await rule.prepare(ctx);
  return [...(rule.needles?.() ?? ["<undefined>"])].sort();
}

describe("rule needles", () => {
  it("path: basenames of the files and directories gone from head, raw and percent-encoded", async () => {
    const needles = await needlesAfterPrepare(
      pathRule(),
      {
        "README.md": "x",
        "src/old/a.ts": "",
        "src/keep.ts": "",
        "my docs/Guide.md": "",
      },
      { "README.md": "x", "src/keep.ts": "", "lib/a.ts": "" },
    );
    expect(needles).toEqual([
      "a.ts",
      "guide.md",
      "my docs",
      "my%20docs",
      "old",
    ]);
  });

  it("path: nothing removed, no needles", async () => {
    expect(
      await needlesAfterPrepare(
        pathRule(),
        { "a.md": "" },
        { "a.md": "", "b.md": "" },
      ),
    ).toEqual([]);
  });

  it("npm-script: scripts the head package in the same directory lacks, with their npm aliases", async () => {
    const base = {
      "package.json": pkg({
        scripts: { build: "tsc", test: "vitest", lint: "eslint" },
      }),
    };
    const head = {
      "package.json": pkg({ scripts: { compile: "tsc", lint: "eslint" } }),
    };
    expect(await needlesAfterPrepare(npmScriptRule(), base, head)).toEqual([
      "build",
      "t",
      "test",
      "tst",
    ]);
  });

  it("npm-script: a removed package contributes all its scripts", async () => {
    const base = {
      "package.json": pkg({}),
      "pkgs/a/package.json": pkg({ scripts: { dev: "vite" } }),
    };
    expect(
      await needlesAfterPrepare(npmScriptRule(), base, {
        "package.json": pkg({}),
      }),
    ).toEqual(["dev"]);
  });

  it("bin: bins of base that no head package defines", async () => {
    const base = { "package.json": pkg({ bin: { foo: "a.js", bar: "b.js" } }) };
    const head = {
      "package.json": pkg({ bin: { foo: "a.js" } }),
      "x/package.json": pkg({ bin: { Baz: "c.js" } }),
    };
    expect(await needlesAfterPrepare(binRule(), base, head)).toEqual(["bar"]);
  });

  it("make-target: targets the head makefile at the same path lacks", async () => {
    const base = {
      Makefile: "build:\n\tgo build\nTest:\n\tgo test\n",
      "tools.mk": "gen:\n\tgo generate\n",
    };
    const head = { Makefile: "build:\n\tgo build\n" };
    expect(await needlesAfterPrepare(makeTargetRule(), base, head)).toEqual([
      "gen",
      "test",
    ]);
  });

  it("env: the confirmed names only", async () => {
    const hunks: DiffHunk[] = [
      {
        path: "src/config.ts",
        removed: ["const u = process.env.OLD_URL;"],
        added: [],
      },
    ];
    const base = { "src/config.ts": "const u = process.env.OLD_URL;\n" };
    expect(
      await needlesAfterPrepare(
        envRule(),
        base,
        { "src/config.ts": "" },
        hunks,
      ),
    ).toEqual(["old_url"]);
    expect(await needlesAfterPrepare(envRule(), base, base, hunks)).toEqual([]);
  });
});

describe("needlesOf", () => {
  const rule = (needles: string[] | undefined): Rule => ({
    id: "r",
    kinds: [],
    prepare: async () => undefined,
    check: () => undefined,
    needles: () => needles,
  });

  it("unions the rules, and is undefined when one rule cannot tell", () => {
    expect(needlesOf([rule(["a"]), rule(["b", "a"])])?.sort()).toEqual([
      "a",
      "b",
    ]);
    expect(needlesOf([rule(["a"]), rule(undefined)])).toBeUndefined();
    const { needles: _, ...withoutMethod } = rule([]);
    expect(needlesOf([withoutMethod])).toBeUndefined();
    expect(needlesOf([])).toEqual([]);
  });
});

describe("mentionsAny", () => {
  it("compares lowercase and ignores backslash escapes", () => {
    expect(mentionsAny("See `SRC/Old.ts`", ["old.ts"])).toBe(true);
    expect(mentionsAny("run make\\_target", ["make_target"])).toBe(true);
    expect(mentionsAny("nothing here", ["old.ts"])).toBe(false);
    expect(mentionsAny("anything", [])).toBe(false);
  });
});

describe("runCheck with needles", () => {
  it("reads no doc when no rule can flag anything", async () => {
    const files = { "README.md": "See `src/a.ts`.\n", "src/a.ts": "" };
    const head = memorySnapshot(files);
    let reads = 0;
    const counting: RepoSnapshot = {
      ...head,
      readFiles: async (paths) => {
        reads += paths.length;
        return head.readFiles(paths);
      },
    };
    const result = await runCheck(
      memorySnapshot(files),
      counting,
      changeSet(),
      { rules: [pathRule()] },
    );
    expect(result.findings).toEqual([]);
    expect(reads).toBe(0);
  });

  it("still flags a reference in a doc that names the removed file", async () => {
    const base = {
      "README.md": "See `src/a.ts` and [b](src/b.ts).\n",
      "src/a.ts": "",
      "src/b.ts": "",
    };
    const head = {
      "README.md": base["README.md"],
      "src/b.ts": "",
      "other.md": "no mention\n",
    };
    const result = await runCheck(
      memorySnapshot(base),
      memorySnapshot(head),
      changeSet({ deleted: ["src/a.ts"] }),
      {
        rules: [pathRule()],
      },
    );
    expect(result.findings.map((f) => `${f.file}:${f.line}:${f.fact}`)).toEqual(
      ["README.md:1:src/a.ts"],
    );
  });
});
