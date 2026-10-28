// Token shapes: which strings look like a repo path or an environment variable.
// Pure string functions; precision matters more than recall, so every rule here
// errs towards "not a reference" (or towards shadow) when in doubt.

/** Extensions that make a bare token such as `README.md` look like a file. */
export const KNOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "mdx",
  "mdc",
  "markdown",
  "txt",
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "lock",
  "sh",
  "bash",
  "zsh",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "php",
  "css",
  "scss",
  "html",
]);

/** Environment variables that are never defined by the project itself. */
export const WELL_KNOWN_ENV_VARS: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "SHELL",
  "TERM",
  "HOSTNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "DISPLAY",
  "COLUMNS",
  "LINES",
  "PS1",
  "IFS",
  "UID",
  "EUID",
  "RANDOM",
  "LINENO",
  "SECONDS",
  "OSTYPE",
  "HOSTTYPE",
  "CI",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "FORCE_COLOR",
  "NO_COLOR",
  "COLORTERM",
]);

/** Prefixes of variables set by the CI runner or the package manager. */
export const WELL_KNOWN_ENV_PREFIXES: readonly string[] = [
  "GITHUB_",
  "RUNNER_",
  "npm_",
];

export function isWellKnownEnv(name: string): boolean {
  return (
    WELL_KNOWN_ENV_VARS.has(name) ||
    WELL_KNOWN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** SCREAMING_SNAKE with at least one underscore: the only bare form we trust as an env var. */
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** A valid shell variable name written in upper case, as project-defined env vars are. */
const UPPER_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function isBareEnvName(token: string): boolean {
  return SCREAMING_SNAKE.test(token) && !isWellKnownEnv(token);
}

/** `NAME=value` assignment names: upper case only, lower-case ones are shell locals. */
export function isAssignedEnvName(name: string): boolean {
  return UPPER_ENV_NAME.test(name) && !isWellKnownEnv(name);
}

/** `$NAME` / `${NAME}` accept any valid name, except the well-known ones. */
export function isUsedEnvName(name: string): boolean {
  return !isWellKnownEnv(name);
}

/** The repository a doc lives in. `defaultBranch` lets links into it count as live, like `main`. */
export interface RepoIdentity {
  owner: string;
  name: string;
  defaultBranch?: string;
}

export interface PathShape {
  normalized: string;
  shadow: boolean;
}

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_SCHEME = /^(?:mailto|tel|data|javascript|file):/i;
const DOMAIN_FIRST_SEGMENT =
  /^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|ai|co|me|edu|gov|eu|it)$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const FRACTION_OR_DATE = /^[+-]?\d+(?:\/[+-]?\d+)+\/?$/;
const TEXT_EXTENSION = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$/;
const CODE_PATH = /^[\w@.+%/-]+$/;
const GLOB_PATH = /^[\w@.+%/*?[\]{},-]+$/;
const GLOB_CHARS = /[*?[\]{}]/;

function stripDotSlash(path: string): string {
  let out = path;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function extensionOf(path: string): string | undefined {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : undefined;
}

function isMeaningful(path: string): boolean {
  return /[A-Za-z0-9]/.test(path) && !/^[./]*$/.test(path);
}

/**
 * Path shape for inline code and shell arguments: no spaces, no placeholders,
 * either a `/` or a known file extension. Globs are returned as shadow.
 */
export function pathFromCode(token: string): PathShape | undefined {
  if (token === "" || token.startsWith("-") || token.startsWith("~"))
    return undefined;
  if (SCHEME_URL.test(token) || OPAQUE_SCHEME.test(token)) return undefined;
  const hash = token.indexOf("#");
  const withoutAnchor = hash >= 0 ? token.slice(0, hash) : token;
  const bare = withoutAnchor.replace(LINE_SUFFIX, "");
  const glob = GLOB_CHARS.test(bare);
  if (!(glob ? GLOB_PATH : CODE_PATH).test(bare)) return undefined;
  const normalized = stripDotSlash(bare);
  if (!isMeaningful(normalized) || FRACTION_OR_DATE.test(normalized))
    return undefined;
  const ext = extensionOf(normalized);
  if (
    !normalized.includes("/") &&
    !(ext !== undefined && KNOWN_FILE_EXTENSIONS.has(ext))
  )
    return undefined;
  // Outside links a leading '/' is a filesystem path (`/etc/nginx/nginx.conf`), not the repo root.
  return { normalized, shadow: glob || normalized.startsWith("/") };
}

/**
 * Path shape for plain prose, deliberately strict. Reported only when the token
 * has a `/` and either a dot-extension or a trailing `/`. A bare `README.md`
 * (known extension, no `/`) is shadow.
 */
export function pathFromText(token: string): PathShape | undefined {
  if (SCHEME_URL.test(token) || OPAQUE_SCHEME.test(token)) return undefined;
  const hash = token.indexOf("#");
  const bare = (hash >= 0 ? token.slice(0, hash) : token).replace(
    LINE_SUFFIX,
    "",
  );
  if (bare === "" || !/^[\w@.+*?/-]+$/.test(bare)) return undefined;
  const glob = /[*?]/.test(bare);
  const normalized = stripDotSlash(bare);
  if (!isMeaningful(normalized)) return undefined;

  if (!normalized.includes("/")) {
    const ext = extensionOf(normalized);
    if (
      glob ||
      ext === undefined ||
      !KNOWN_FILE_EXTENSIONS.has(ext) ||
      normalized.startsWith(".")
    ) {
      return undefined;
    }
    return { normalized, shadow: true };
  }

  const segments = normalized.split("/");
  const trailingSlash = normalized.endsWith("/");
  const first = segments[0] ?? "";
  if (/^[A-Za-z]\/$/.test(normalized) || FRACTION_OR_DATE.test(normalized))
    return undefined;
  if (first !== "" && !bare.startsWith(".") && DOMAIN_FIRST_SEGMENT.test(first))
    return undefined;
  if (!trailingSlash && !TEXT_EXTENSION.test(normalized)) return undefined;
  return { normalized, shadow: glob || normalized.startsWith("/") };
}

/** Branch names that track the tip of the repository, so a link into them follows renames. */
const LIVE_REFS: ReadonlySet<string> = new Set([
  "main",
  "master",
  "HEAD",
  "trunk",
]);

/**
 * Same-repo `github.com/<owner>/<repo>/(blob|tree)/<ref>/<path>` URLs map to a
 * root-anchored path. `live` is false for a ref pinned to a commit, a tag or
 * another branch: such a link keeps working after a rename, so it must not be reported.
 */
function githubRepoPath(
  url: string,
  repo: RepoIdentity,
): { path: string; live: boolean } | undefined {
  const sameRepo = (owner: string | undefined, name: string | undefined) =>
    owner?.toLowerCase() === repo.owner.toLowerCase() &&
    name?.toLowerCase() === repo.name.toLowerCase();
  // A workflow's page (or its status badge) names its file, which lives at the head of the default branch.
  const workflow =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/?#]+\.ya?ml)(?:\/badge\.svg)?(?:[?#].*)?$/i.exec(
      url,
    );
  if (workflow) {
    const [, owner, name, file = ""] = workflow;
    return sameRepo(owner, name)
      ? { path: `.github/workflows/${file}`, live: true }
      : undefined;
  }
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/i.exec(
      url,
    );
  if (!match) return undefined;
  const [, owner, name, ref = "", rest = ""] = match;
  if (!sameRepo(owner, name)) return undefined;
  const live =
    LIVE_REFS.has(ref) ||
    (repo.defaultBranch !== undefined && ref === repo.defaultBranch);
  return { path: rest, live };
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Path of a link, image or definition URL: relative URLs and same-repo GitHub
 * URLs only, anchor and query stripped, percent-decoded.
 */
export function pathFromUrl(
  url: string,
  repo: RepoIdentity | undefined,
): PathShape | undefined {
  const trimmed = url.trim();
  let target: string;
  let anchored = false;
  let pinned = false;
  if (/^[a-z][a-z0-9+.-]+:/i.test(trimmed) || trimmed.startsWith("//")) {
    const repoPath = repo ? githubRepoPath(trimmed, repo) : undefined;
    if (repoPath === undefined) return undefined;
    target = repoPath.path;
    pinned = !repoPath.live;
    anchored = true;
  } else {
    target = trimmed;
  }
  if (target.includes("{{") || target.includes("{%")) return undefined;
  const cut = target.search(/[?#]/);
  const withoutQuery = cut >= 0 ? target.slice(0, cut) : target;
  const decoded = stripDotSlash(decode(withoutQuery));
  const normalized = anchored ? `/${decoded}` : decoded;
  if (!isMeaningful(normalized)) return undefined;
  return { normalized, shadow: pinned || GLOB_CHARS.test(normalized) };
}
