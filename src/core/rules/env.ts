// Env rule: an environment variable read by removed code has drifted when no non-doc file of head
// still mentions it (docs/decisions.md, phase 3). Candidates come from the removed diff lines, so
// the rule works in diff mode only: scan mode computes no hunks and the rule then reports nothing.
import { isIndexedDoc } from "../indexer.ts";
import type { Reference } from "../reference.ts";
import type { Drift, Rule } from "../rules.ts";
import { isWellKnownEnv } from "../shapes.ts";

/** At most this many removed names are checked per run (one `git grep` each); the rest are reported as a warning. */
export const MAX_CANDIDATES = 200;

/** Prefixes of variables that SDKs and tools read from the environment by themselves, with no accessor in the project. */
export const SDK_ENV_PREFIXES: readonly string[] = [
  "OPENAI_",
  "ANTHROPIC_",
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "GCP_",
  "SENTRY_",
  "VERCEL_",
  "NETLIFY_",
  "SUPABASE_",
  "STRIPE_",
  "HF_",
  "HUGGINGFACE_",
  "GEMINI_",
  "MISTRAL_",
  "COHERE_",
  "GROQ_",
  "LANGCHAIN_",
  "LANGSMITH_",
  "OTEL_",
  "DD_",
  "NEW_RELIC_",
  "DOCKER_",
  "KUBE",
  "TF_",
];

/** Exact names read implicitly by drivers, servers and platforms. */
export const SDK_ENV_NAMES: readonly string[] = [
  "PGHOST",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGPORT",
  "DATABASE_URL",
  "REDIS_URL",
  "PORT",
  "HOST",
  "LOG_LEVEL",
  "DEBUG",
];

/** A variable some library consumes on its own: removing the project's own read of it proves nothing. */
export function isSdkEnv(name: string): boolean {
  return (
    SDK_ENV_NAMES.includes(name) ||
    SDK_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const QUOTED = `\\s*['"\`](${NAME})['"\`]\\s*`;

/** Explicit accessors; group 1 is the name. Each pattern is stateful, so they are cloned per call. */
const ACCESSORS: readonly RegExp[] = [
  new RegExp(`(?<![\\w.$])process\\.env\\??\\.(${NAME})`, "g"),
  new RegExp(`(?<![\\w.$])process\\.env\\??\\.?\\[${QUOTED}\\]`, "g"),
  new RegExp(`(?<![\\w.$])import\\.meta\\.env\\??\\.(${NAME})`, "g"),
  new RegExp(`(?<![\\w.$])import\\.meta\\.env\\??\\.?\\[${QUOTED}\\]`, "g"),
  new RegExp(`(?<![\\w.$])os\\.environ\\[${QUOTED}\\]`, "g"),
  new RegExp(`(?<![\\w.$])os\\.environ\\.get\\(${QUOTED}[,)]`, "g"),
  new RegExp(`(?<![\\w.$])os\\.getenv\\(${QUOTED}[,)]`, "g"),
];

const DOTENV_KEY = new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=`);

/** File names that list the variables a project reads. */
const DOTENV_TEMPLATES: ReadonlySet<string> = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  "example.env",
]);

/**
 * Environment variable names a source line reads through an explicit accessor (`process.env.X`,
 * `process.env['X']`, `import.meta.env.X`, `os.environ[...]`, `os.environ.get(...)`, `os.getenv(...)`),
 * each once, in order of appearance. With `dotenv`, also the key of a `KEY=value` / `export KEY=value` line.
 */
export function envNamesIn(line: string, dotenv = false): string[] {
  const found: { index: number; name: string }[] = [];
  for (const pattern of ACCESSORS) {
    for (const match of line.matchAll(new RegExp(pattern))) {
      found.push({ index: match.index, name: match[1] as string });
    }
  }
  if (dotenv) {
    const key = DOTENV_KEY.exec(line)?.[1];
    if (key !== undefined) found.push({ index: 0, name: key });
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((f) => f.name))];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A file that only talks about the project: a mention there does not keep a variable alive. */
function isDocFile(path: string): boolean {
  return (
    isIndexedDoc(path) ||
    /\.(?:md|mdx|mdc)$/i.test(path) ||
    basename(path) === ".cursorrules"
  );
}

function namesOf(lines: readonly string[], dotenv: boolean): string[] {
  return [...new Set(lines.flatMap((line) => envNamesIn(line, dotenv)))];
}

function describeChange(name: string, renamedTo: string | undefined): string {
  return renamedTo === undefined
    ? `environment variable \`${name}\` is no longer read anywhere in the code after this change`
    : `environment variable \`${name}\` was renamed to \`${renamedTo}\` in this change`;
}

/**
 * Flags an env-var reference of a head doc when the variable was read in a removed line of a non-doc file,
 * base has a non-doc file mentioning it, and `git grep -wi NAME head` finds it in no
 * non-doc file. Names SDKs read by themselves (`isSdkEnv`) are never candidates. A rename is suggested only when every hunk
 * that removes the name removes just it and adds exactly one other name.
 *
 * At most `MAX_CANDIDATES` names (sorted) are grepped; a warning says when more were removed.
 * A factory: the rule keeps its confirmed set for one run.
 */
export function envRule(): Rule {
  let confirmed: ReadonlyMap<string, string | undefined> | undefined;

  return {
    id: "env",
    kinds: ["env"],

    async prepare(ctx) {
      // name -> suggestion per hunk that removes it; `undefined` means that hunk offers none.
      const proposals = new Map<string, (string | undefined)[]>();
      for (const hunk of ctx.hunks) {
        if (isDocFile(hunk.path)) continue; // a code sample in a doc is not a reader of the variable
        const dotenv = DOTENV_TEMPLATES.has(basename(hunk.path));
        const removed = namesOf(hunk.removed, dotenv);
        const added = namesOf(hunk.added, dotenv);
        const [only] = removed;
        const [replacement] = added;
        const suggestion =
          removed.length === 1 && added.length === 1 && only !== replacement
            ? replacement
            : undefined;
        for (const name of removed) {
          if (isWellKnownEnv(name) || isSdkEnv(name)) continue;
          const list = proposals.get(name) ?? [];
          list.push(removed.length === 1 ? suggestion : undefined);
          proposals.set(name, list);
        }
      }

      const names = [...proposals.keys()].sort();
      let candidates = names;
      if (names.length > MAX_CANDIDATES) {
        candidates = names.slice(0, MAX_CANDIDATES);
        ctx.warn(
          `environment variable check limited to the first ${MAX_CANDIDATES} of ${names.length} removed names: later ones were not checked`,
        );
      }

      const result = new Map<string, string | undefined>();
      for (const name of candidates) {
        const baseHits = await ctx.base.grep(name);
        if (!baseHits.some((hit) => !isDocFile(hit.path))) continue; // no code ever read it
        // Case-insensitive: a settings library reads `database_url` for DATABASE_URL, so a non-doc mention in
        // another case counts as still in use.
        const hits = await ctx.head.grep(name, { ignoreCase: true });
        if (hits.some((hit) => !isDocFile(hit.path))) continue;
        const list = proposals.get(name) ?? [];
        const first = list[0];
        result.set(name, list.every((s) => s === first) ? first : undefined);
      }
      confirmed = result;
    },

    check(ref: Reference): Drift | undefined {
      if (confirmed === undefined)
        throw new Error("envRule: prepare() must run before check()");
      if (!confirmed.has(ref.normalized)) return undefined;
      const renamedTo = confirmed.get(ref.normalized);
      return {
        fact: `env:${ref.normalized}`,
        message: describeChange(ref.normalized, renamedTo),
        ...(renamedTo === undefined ? {} : { suggestion: renamedTo }),
      };
    },

    needles(): readonly string[] {
      if (confirmed === undefined)
        throw new Error("envRule: prepare() must run before needles()");
      return [...confirmed.keys()].map((name) => name.toLowerCase());
    },
  };
}
