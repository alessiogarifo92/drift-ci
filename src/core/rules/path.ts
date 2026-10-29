// Path rule: a path reference in a head doc has drifted when it resolved to
// something in base and resolves to nothing in head (docs/decisions.md, phase 3).
import { posix } from "node:path";
import ignore, { type Ignore } from "ignore";
import { codeName } from "../message.ts";
import type { Reference } from "../reference.ts";
import type { CheckContext, Drift, Rule } from "../rules.ts";
import type { ChangeSet, SnapshotEntry } from "../snapshot.ts";

/** A removed path under one of these directories is a build product, not documentation drift. */
const BUILD_DIRS: ReadonlySet<string> = new Set([
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
]);

/** What one commit contains, as a path set: files, their ancestor directories and submodules. */
interface Inventory {
  /** Every non-directory entry: files, symlinks and submodule gitlinks. */
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
  submodules: ReadonlySet<string>;
}

/** One place a reference may point to, and the directory (`''` = repo root) it was resolved from. */
interface Candidate {
  path: string;
  origin: string;
}

interface State {
  base: Inventory;
  head: Inventory;
  renamed: ReadonlyMap<string, string>;
  /** Longest source directory first, so the nearest renamed directory wins. */
  renamedDirs: readonly { from: string; to: string }[];
  isIgnoredInHead: (path: string, isDir: boolean) => boolean;
}

function inventoryOf(entries: readonly SnapshotEntry[]): Inventory {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const submodules = new Set<string>();
  for (const { path, kind } of entries) {
    files.add(path);
    if (kind === "submodule") submodules.add(path);
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++)
      dirs.add(segments.slice(0, i).join("/"));
  }
  return { files, dirs, submodules };
}

/** A path exists when it is an entry, a directory with entries under it, or inside a submodule. */
function exists(inv: Inventory, path: string): boolean {
  if (inv.files.has(path) || inv.dirs.has(path)) return true;
  if (inv.submodules.size === 0) return false;
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    if (inv.submodules.has(segments.slice(0, i).join("/"))) return true;
  }
  return false;
}

/** Repo-relative form of `path`, or `undefined` when it is the root itself or escapes the repository. */
function clean(path: string): string | undefined {
  const normalized = posix.normalize(path).replace(/\/+$/, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    return undefined;
  return normalized;
}

/** Nearest ancestor directory of the doc (its own directory included) that holds a package.json. */
function packageRoot(inv: Inventory, docPath: string): string | undefined {
  let dir = posix.dirname(docPath);
  while (dir !== "." && dir !== "") {
    if (inv.files.has(`${dir}/package.json`)) return dir;
    dir = posix.dirname(dir);
  }
  return undefined;
}

/** Where a path reference of the doc may point to, in order of preference. */
function candidatesFor(
  inv: Inventory,
  docPath: string,
  normalized: string,
): Candidate[] {
  const origins: { origin: string; path: string }[] = [];
  if (normalized.startsWith("/")) {
    origins.push({ origin: "", path: normalized.replace(/^\/+/, "") });
  } else {
    const docDir = posix.dirname(docPath);
    origins.push({
      origin: docDir === "." ? "" : docDir,
      path: posix.join(docDir, normalized),
    });
    const pkg = packageRoot(inv, docPath);
    if (pkg !== undefined)
      origins.push({ origin: pkg, path: posix.join(pkg, normalized) });
    origins.push({ origin: "", path: normalized });
  }
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const { origin, path } of origins) {
    const cleaned = clean(path);
    if (cleaned === undefined || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push({ path: cleaned, origin });
  }
  return result;
}

function underBuildDir(path: string): boolean {
  return path.split("/").some((segment) => BUILD_DIRS.has(segment));
}

/** Where git says `path` went: its own rename, else the rename of the nearest renamed directory. */
function movedTo(state: State, path: string): string | undefined {
  const renamed = state.renamed.get(path);
  if (renamed !== undefined) return renamed;
  for (const { from, to } of state.renamedDirs) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  }
  return undefined;
}

const LINK_SOURCES: ReadonlySet<Reference["source"]> = new Set([
  "link",
  "image",
  "definition",
]);

/** A path written into a link: each segment percent-encoded, parentheses included. */
function encodeLinkPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[()]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** The destination of a link, image or definition as written, from the column of its path on. */
function rawDestination(ref: Reference): string | undefined {
  const token = ref.contextLine.slice(ref.col - 1);
  const raw =
    ref.contextLine[ref.col - 2] === "<"
      ? /^[^>]*/.exec(token)
      : /^[^\s)]*/.exec(token);
  return raw?.[0];
}

/** What follows the path of a reference as written: a link's `?query#anchor`, code's `:line` and `#anchor`. */
function suffixOf(ref: Reference, raw: string | undefined): string {
  if (raw !== undefined) {
    const cut = raw.search(/[?#]/);
    return cut >= 0 ? raw.slice(cut) : "";
  }
  let rest = ref.contextLine.slice(ref.col - 1);
  while (rest.startsWith("./")) rest = rest.slice(2);
  if (!rest.startsWith(ref.normalized)) return "";
  return (
    /^(?::\d+(?::\d+)?)?(?:#[\w.:/-]*[\w/-])?/.exec(
      rest.slice(ref.normalized.length),
    )?.[0] ?? ""
  );
}

/**
 * `newPath` written the way the doc wrote the reference (relative or rooted, `./`, trailing `/`, `?query`,
 * `#anchor` and `:line` suffix, percent-encoding in links), or `undefined` when its text is not a path.
 */
function styled(
  ref: Reference,
  origin: string,
  newPath: string,
): string | undefined {
  const token = ref.contextLine.slice(ref.col - 1);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return undefined; // a URL: the text to replace is not a path
  const isLink = LINK_SOURCES.has(ref.source);
  const raw = isLink ? rawDestination(ref) : undefined;
  if (raw !== undefined && raw.includes("(")) return undefined; // the extent of the destination is unclear
  let text: string;
  if (ref.normalized.startsWith("/")) {
    text = `/${newPath}`;
  } else {
    text = origin === "" ? newPath : posix.relative(origin, newPath);
    if (text === "") return undefined;
    if (token.startsWith("./") && !text.startsWith("../")) text = `./${text}`;
  }
  if (ref.normalized.endsWith("/") && !text.endsWith("/")) text = `${text}/`;
  if (isLink) {
    const path = raw?.replace(/[?#].*$/, "") ?? "";
    if (/%[0-9A-Fa-f]{2}/.test(path) || /[\s()#?%<>]/.test(text))
      text = encodeLinkPath(text);
  }
  return `${text}${suffixOf(ref, raw)}`;
}

/** Rules of every `.gitignore` of the head commit, shallowest directory first. */
async function loadGitignores(
  ctx: CheckContext,
): Promise<{ dir: string; rules: Ignore }[]> {
  const paths = ctx.headFiles
    .filter((e) => e.kind === "file" && posix.basename(e.path) === ".gitignore")
    .map((e) => e.path);
  const contents = await ctx.head.readFiles(paths);
  return paths
    .map((path) => ({
      dir: posix.dirname(path) === "." ? "" : posix.dirname(path),
      rules: ignore({ ignorecase: false }).add(contents.get(path) ?? ""),
    }))
    .sort(
      (a, b) =>
        a.dir.split("/").length - b.dir.split("/").length ||
        (a.dir < b.dir ? -1 : 1),
    );
}

function ignoreMatcher(
  gitignores: readonly { dir: string; rules: Ignore }[],
): State["isIgnoredInHead"] {
  return (path, isDir) => {
    let ignored = false;
    // Deeper files take precedence over shallower ones, as in git.
    for (const { dir, rules } of gitignores) {
      if (dir !== "" && !path.startsWith(`${dir}/`)) continue;
      const relative = dir === "" ? path : path.slice(dir.length + 1);
      const result = rules.test(isDir ? `${relative}/` : relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  };
}

function describeChange(fact: string, movedTo: string | undefined): string {
  return movedTo === undefined
    ? `${codeName(fact)} was removed in this change`
    : `${codeName(fact)} was renamed to ${codeName(movedTo)} in this change`;
}

/**
 * Flags a path reference that resolved in base and resolves to nothing in head. A reference of a doc
 * is looked up doc-relative, then against the nearest package root, then against the repo root
 * (a leading `/` means the repo root only); it is flagged only when the first candidate that
 * existed in base is gone and no candidate exists in head.
 *
 * Removed paths under a build directory or ignored by the head `.gitignore` files are not reported.
 * In scan mode a reference is flagged when no candidate exists in head (the same two exemptions apply, and
 * a token with neither extension nor trailing `/` must sit in a directory that exists).
 * A factory: the rule keeps its inventories for one run.
 */
export function pathRule(): Rule {
  let state: State | undefined;

  return {
    id: "path",
    kinds: ["path"],

    async prepare(ctx) {
      const changes: ChangeSet = ctx.changes;
      state = {
        base: inventoryOf(ctx.baseFiles),
        head: inventoryOf(ctx.headFiles),
        renamed: new Map(changes.renamed.map((r) => [r.from, r.to])),
        renamedDirs: [...changes.renamedDirs].sort(
          (a, b) => b.from.length - a.from.length,
        ),
        isIgnoredInHead: ignoreMatcher(await loadGitignores(ctx)),
      };
    },

    check(ref, doc): Drift | undefined {
      const s = state;
      if (s === undefined)
        throw new Error("pathRule: prepare() must run before check()");

      const matched = candidatesFor(s.base, doc.path, ref.normalized).find(
        (c) => exists(s.base, c.path),
      );
      if (matched === undefined) return undefined; // never resolved: a pre-existing broken reference
      // GitHub resolves a link doc-relative (or from the root when it starts with `/`) and never through the
      // package-root or repo-root fallback: such a link was already broken there.
      if (LINK_SOURCES.has(ref.source) && !ref.normalized.startsWith("/")) {
        const docRelative = clean(
          posix.join(posix.dirname(doc.path), ref.normalized),
        );
        if (matched.path !== docRelative) return undefined;
      }

      const inHead = [
        ...candidatesFor(s.head, doc.path, ref.normalized),
        ...candidatesFor(s.base, doc.path, ref.normalized),
      ];
      if (inHead.some((c) => exists(s.head, c.path))) return undefined;

      if (
        underBuildDir(matched.path) ||
        s.isIgnoredInHead(matched.path, s.base.dirs.has(matched.path))
      ) {
        return undefined;
      }

      const target = movedTo(s, matched.path);
      const drift: Drift = {
        fact: matched.path,
        message: describeChange(matched.path, target),
      };
      if (target !== undefined) {
        const suggestion = styled(ref, matched.origin, target);
        if (suggestion !== undefined) drift.suggestion = suggestion;
      }
      return drift;
    },

    needles(): readonly string[] {
      const s = state;
      if (s === undefined)
        throw new Error("pathRule: prepare() must run before needles()");
      // A flagged reference resolves to a path of base that does not exist in head, and the last segment of
      // what the doc wrote is that path's basename (a reference ending in `..` is the one exception, and it
      // resolves to an ancestor of the doc, which exists in head).
      const result = new Set<string>();
      for (const path of [...s.base.files, ...s.base.dirs]) {
        if (exists(s.head, path)) continue;
        const name = posix.basename(path).toLowerCase();
        result.add(name);
        result.add(encodeURIComponent(name).toLowerCase());
        if (name.includes("&")) result.add(name.replaceAll("&", "&amp;"));
      }
      return [...result];
    },

    scan(ref, doc): Drift | undefined {
      const s = state;
      if (s === undefined)
        throw new Error("pathRule: prepare() must run before scan()");

      const candidates = candidatesFor(s.head, doc.path, ref.normalized);
      const [first] = candidates;
      if (first === undefined || candidates.some((c) => exists(s.head, c.path)))
        return undefined;
      // Without a base nothing says whether the path is a file or a directory: ignore both readings.
      const buildProduct = (path: string) =>
        underBuildDir(path) ||
        s.isIgnoredInHead(path, false) ||
        s.isIgnoredInHead(path, true);
      if (candidates.some((c) => buildProduct(c.path))) return undefined;
      // `owner/repo`, `and/or`: without an extension or a trailing `/` the token is only a path when it sits in a directory that exists.
      if (
        !/\.[A-Za-z0-9]+$/.test(first.path) &&
        !ref.normalized.endsWith("/")
      ) {
        const hasParent = candidates.some(
          (c) =>
            posix.dirname(c.path) === "." ||
            exists(s.head, posix.dirname(c.path)),
        );
        if (!hasParent) return undefined;
      }
      return {
        fact: first.path,
        message: `${codeName(ref.normalized)} does not exist at this commit`,
      };
    },
  };
}
