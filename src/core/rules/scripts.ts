// npm-script rule: a script reference in a head doc has drifted when the package it resolves to defined that
// script in base and no longer does in head (docs/decisions.md, phase 3). Scripts are keyed by (package, name).
import { codeName } from "../message.ts";
import { NPM_IMPLICIT_SCRIPTS } from "../shell.ts";
import type { Reference } from "../reference.ts";
import type { Drift, Rule } from "../rules.ts";
import {
  loadPackages,
  resolveCwdDir,
  type PackageInfo,
  type PackageSet,
  type Packages,
} from "./packages.ts";

/** The package a reference points to on one side: `-w`/`--filter` workspace, else cwd, else the doc's directory. */
function resolveIn(
  set: PackageSet,
  ref: Reference,
  docPath: string,
): PackageInfo | undefined {
  const workspace = ref.context?.workspace;
  if (workspace !== undefined) return set.byWorkspace(workspace);
  const cwd = ref.context?.cwd;
  if (cwd !== undefined) {
    const dir = resolveCwdDir(docPath, cwd);
    return dir === undefined ? undefined : set.nearest(dir);
  }
  return set.nearest(resolveCwdDir(docPath, ".") ?? "");
}

/** Whether the reference names a place this rule can locate at all (a cwd like `/srv` or `$DIR` cannot be). */
function locatable(ref: Reference, docPath: string): boolean {
  const cwd = ref.context?.cwd;
  return (
    ref.context?.workspace !== undefined ||
    cwd === undefined ||
    resolveCwdDir(docPath, cwd) !== undefined
  );
}

/** `npm run x` / `pnpm run x`: the only forms that run nothing but a package.json script. */
const EXPLICIT_RUN =
  /(?:^|[\s`'"(])(?:npm|pnpm)\s(?:\S+\s)*?(?:run|run-script)\s(?:\S+\s)*$/;

/**
 * Whether the reference is the script of an explicit `npm run` / `pnpm run` (not `npm start`, which runs
 * `server.js` without a script, nor `pnpm x`, `yarn x`, `bun run x`, which may run a bin or a file), the
 * only forms scan mode trusts. `--if-present` makes a missing script fine.
 */
function isExplicitRun(ref: Reference): boolean {
  const manager = ref.context?.packageManager;
  if (
    (manager !== "npm" && manager !== "pnpm") ||
    ref.contextLine.includes("--if-present")
  )
    return false;
  // Inline code is its own command: the prose around it says nothing about how the script is run.
  const open =
    ref.source === "inline-code"
      ? ref.contextLine.lastIndexOf("`", ref.col - 2)
      : -1;
  const before = ref.contextLine.slice(open + 1, ref.col - 1);
  const command = before.split(/&&|\|\||[;|]/).pop() ?? "";
  return EXPLICIT_RUN.test(command);
}

function labelOf(pkg: PackageInfo): string {
  return pkg.name ?? pkg.path;
}

/** The new name when exactly one script went away, exactly one appeared, and both run the same command. */
function renamedTo(
  before: PackageInfo,
  after: PackageInfo | undefined,
  name: string,
): string | undefined {
  if (after === undefined) return undefined;
  const removed = [...before.scripts.keys()].filter(
    (key) => !after.scripts.has(key),
  );
  const added = [...after.scripts.keys()].filter(
    (key) => !before.scripts.has(key),
  );
  if (removed.length !== 1 || removed[0] !== name || added.length !== 1)
    return undefined;
  const [newName] = added as [string];
  const body = before.scripts.get(name)?.trim();
  return body !== undefined &&
    body !== "" &&
    body === after.scripts.get(newName)?.trim()
    ? newName
    : undefined;
}

/**
 * Flags an npm script reference whose script exists in the package it resolves to in base and not in the
 * head version of that package. Implicit scripts (`npm test`, `npm start`...) follow the same rule: only a
 * script defined in base `scripts` and gone in head is flagged. A package.json that does not parse is
 * warned about and ignored on both sides. In scan mode only an explicit `npm run` / `pnpm run` of a script the
 * resolved package lacks is flagged. A factory: the rule keeps its inventories for one run.
 */
export function npmScriptRule(): Rule {
  let packages: Packages | undefined;

  return {
    id: "npm-script",
    kinds: ["npm-script"],

    async prepare(ctx) {
      packages = await loadPackages(ctx);
    },

    check(ref, doc): Drift | undefined {
      if (packages === undefined)
        throw new Error("npmScriptRule: prepare() must run before check()");
      if (!locatable(ref, doc.path) || ref.context?.allWorkspaces)
        return undefined;

      const name = ref.normalized;
      const before = resolveIn(packages.base, ref, doc.path);
      if (before === undefined || !before.scripts.has(name)) return undefined; // never existed: not drift

      // A renamed package keeps its place: fall back to the directory the base package lived in.
      const after =
        resolveIn(packages.head, ref, doc.path) ??
        (ref.context?.workspace !== undefined
          ? packages.head.at(before.dir)
          : undefined);
      if (after?.scripts.has(name)) return undefined;
      // A package.json added between the doc and the base package changes which package the doc
      // resolves to; the script itself is still where base found it, so nothing was removed.
      if (
        after?.path !== before.path &&
        packages.head.at(before.dir)?.scripts.has(name)
      )
        return undefined;

      const drift: Drift = {
        fact: `${before.path}#${name}`,
        message: `npm script ${codeName(name)} (package ${codeName(labelOf(before))}) was removed in this change`,
      };
      const newName = renamedTo(before, after, name);
      if (newName !== undefined) {
        drift.message = `npm script ${codeName(name)} (package ${codeName(labelOf(before))}) was renamed to ${codeName(newName)} in this change`;
        drift.suggestion = newName;
      }
      return drift;
    },

    needles(): readonly string[] {
      if (packages === undefined)
        throw new Error("npmScriptRule: prepare() must run before needles()");
      // A flagged script is defined by a base package and missing from the head package in the same directory
      // (a head package elsewhere that lacks it is not enough: `check` then finds it where base did).
      const result = new Set<string>();
      for (const before of packages.base.packages) {
        const after = packages.head.at(before.dir);
        for (const name of before.scripts.keys()) {
          if (after?.scripts.has(name)) continue;
          result.add(name.toLowerCase());
          // `npm t` runs `test`: the doc may only hold the alias.
          for (const [alias, script] of NPM_IMPLICIT_SCRIPTS)
            if (script === name) result.add(alias);
        }
      }
      return [...result];
    },

    scan(ref, doc): Drift | undefined {
      if (packages === undefined)
        throw new Error("npmScriptRule: prepare() must run before scan()");
      if (
        !isExplicitRun(ref) ||
        !locatable(ref, doc.path) ||
        ref.context?.allWorkspaces
      )
        return undefined;

      const name = ref.normalized;
      const target = resolveIn(packages.head, ref, doc.path);
      if (target === undefined || target.scripts.has(name)) return undefined;
      return {
        fact: `${target.path}#${name}`,
        message: `npm script ${codeName(name)} (package ${codeName(labelOf(target))}) does not exist at this commit`,
      };
    },
  };
}
