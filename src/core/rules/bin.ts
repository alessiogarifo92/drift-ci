// Bin rule: a command in a head doc has drifted when it was a `bin` of some package.json in base and is a
// `bin` of none in head (docs/decisions.md, phase 3). Bins are global once installed, so the inventory is
// the set of bin names across every package.json of the commit.
import { codeName } from "../message.ts";
import type { Drift, Rule } from "../rules.ts";
import { loadPackages, type Packages } from "./packages.ts";

const normalizeFile = (file: string): string => file.replace(/^(?:\.\/)+/, "");

function binNames(set: Packages["base"]): Set<string> {
  return new Set(set.packages.flatMap((p) => [...p.bins.keys()]));
}

/** The base package.json that defined `name`, and the new bin name when the change renamed it in place. */
function renamedTo(packages: Packages, name: string): string | undefined {
  const before = packages.base.packages.find((p) => p.bins.has(name));
  const after =
    before === undefined
      ? undefined
      : packages.head.packages.find((p) => p.path === before.path);
  if (before === undefined || after === undefined) return undefined;
  const removed = [...before.bins.keys()].filter((key) => !after.bins.has(key));
  const added = [...after.bins.keys()].filter((key) => !before.bins.has(key));
  if (removed.length !== 1 || added.length !== 1) return undefined;
  const [newName] = added as [string];
  const file = normalizeFile(before.bins.get(name) ?? "");
  return file !== "" && file === normalizeFile(after.bins.get(newName) ?? "")
    ? newName
    : undefined;
}

/**
 * Flags a `command` reference whose name is a bin in base and not a bin in head. A command that was never a
 * bin (`git`, a shell tool, anything else) is never flagged. A factory: the rule keeps its inventories for one run.
 */
export function binRule(): Rule {
  let state:
    | { packages: Packages; base: Set<string>; head: Set<string> }
    | undefined;

  return {
    id: "bin",
    kinds: ["command"],

    async prepare(ctx) {
      const packages = await loadPackages(ctx);
      state = {
        packages,
        base: binNames(packages.base),
        head: binNames(packages.head),
      };
    },

    check(ref): Drift | undefined {
      if (state === undefined)
        throw new Error("binRule: prepare() must run before check()");
      const name = ref.normalized;
      if (!state.base.has(name) || state.head.has(name)) return undefined;

      const drift: Drift = {
        fact: `bin:${name}`,
        message: `bin ${codeName(name)} was removed in this change`,
      };
      const newName = renamedTo(state.packages, name);
      if (newName !== undefined) {
        drift.message = `bin ${codeName(name)} was renamed to ${codeName(newName)} in this change`;
        drift.suggestion = newName;
      }
      return drift;
    },

    needles(): readonly string[] {
      if (state === undefined)
        throw new Error("binRule: prepare() must run before needles()");
      const { base, head } = state;
      return [...base]
        .filter((name) => !head.has(name))
        .map((name) => name.toLowerCase());
    },
  };
}
