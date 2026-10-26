#!/usr/bin/env node
import { createRequire as __driftCreateRequire } from 'node:module';
const require = __driftCreateRequire(import.meta.url);

// src/cli/main.ts
import { execFileSync } from "node:child_process";

// src/core/index.ts
var FINDING_SCHEMA_VERSION = 1;

// src/cli/main.ts
var VERSION = true ? "0.0.0" : "0.0.0-dev";
var HELP = `Usage: drift-ci [options]

Checks docs and AI-agent context files for references to things renamed or
removed between two commits.

Options:
  --base <ref>   Base commit (default: HEAD^)
  --head <ref>   Head commit (default: HEAD)
  --cwd <dir>    Repository directory (default: current directory)
  -h, --help     Show this help
  -v, --version  Show the version
`;
function parseArgs(argv, defaultCwd) {
  const options = { base: "HEAD^", head: "HEAD", cwd: defaultCwd };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-v":
      case "--version":
        return { kind: "version" };
      case "--base":
      case "--head":
      case "--cwd": {
        const value = argv[i + 1];
        if (value === void 0 || value.startsWith("-")) {
          return { kind: "error", message: `${arg} needs a value` };
        }
        options[arg.slice(2)] = value;
        i++;
        break;
      }
      default:
        return { kind: "error", message: `unknown argument: ${String(arg)}` };
    }
  }
  return { kind: "run", options };
}
function resolveCommit(cwd, ref) {
  return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function run(argv, io) {
  const parsed = parseArgs(argv, io.cwd);
  switch (parsed.kind) {
    case "help":
      io.stdout(HELP);
      return 0;
    case "version":
      io.stdout(`${VERSION}
`);
      return 0;
    case "error":
      io.stderr(`drift-ci: ${parsed.message}

${HELP}`);
      return 2;
    case "run": {
      const { base, head, cwd } = parsed.options;
      let baseSha;
      let headSha;
      try {
        baseSha = resolveCommit(cwd, base);
        headSha = resolveCommit(cwd, head);
      } catch (error) {
        const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
        io.stderr(`drift-ci: cannot resolve commits in ${cwd}: ${detail}
`);
        return 2;
      }
      io.stdout(
        `drift-ci ${VERSION} (finding schema v${FINDING_SCHEMA_VERSION})
base ${baseSha}
head ${headSha}
No checks are implemented yet: 0 findings.
`
      );
      return 0;
    }
  }
}

// src/cli/index.ts
process.exitCode = run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd()
});
