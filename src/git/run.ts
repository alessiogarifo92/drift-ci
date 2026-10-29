// The only place that starts git. Always an argument array, never a shell.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { GitError, GitNotFoundError } from "./errors.ts";

export const DEFAULT_GIT_BINARY = "git";

export interface GitOptions {
  /** Path or name of the git executable. Default: `git` from PATH. */
  gitBinary?: string;
}

export interface RunOptions extends GitOptions {
  /** Written to the process's stdin. */
  input?: string | Uint8Array;
  /** Non-zero exit codes that are a result, not a failure (e.g. 1 for `git grep` without a match). */
  okExitCodes?: readonly number[];
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

// The repository is the directory we are given, whatever the caller's environment says.
const INHERITED_GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  return env;
}

/**
 * Runs `git <args>` in `repoDir`. Output paths come back unquoted (`core.quotePath=false`)
 * and messages in English (`LC_ALL=C`), so callers can parse both.
 *
 * Rejects with `GitNotFoundError` when the executable cannot be started and with
 * `GitError` (carrying stderr and the exit code) on any other failure.
 */
export function runGit(
  repoDir: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<GitResult> {
  const gitBinary = options.gitBinary ?? DEFAULT_GIT_BINARY;
  const okExitCodes = options.okExitCodes ?? [];
  const fullArgs = ["-c", "core.quotePath=false", ...args];

  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(gitBinary, fullArgs, {
      cwd: repoDir,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    // git may exit before reading all of its input; its exit code tells why.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        // spawn reports a missing working directory as ENOENT too.
        reject(
          existsSync(repoDir)
            ? new GitNotFoundError(gitBinary, { args, cause: error })
            : new GitError(`repository directory does not exist: ${repoDir}`, {
                args,
                cause: error,
              }),
        );
        return;
      }
      reject(
        new GitError(`failed to start ${gitBinary}: ${error.message}`, {
          args,
          cause: error,
        }),
      );
    });

    child.on("close", (exitCode) => {
      const result: GitResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? -1,
      };
      if (
        exitCode === 0 ||
        (exitCode !== null && okExitCodes.includes(exitCode))
      ) {
        resolve(result);
        return;
      }
      const detail = result.stderr.trim();
      reject(
        new GitError(
          `git ${args.join(" ")} failed${exitCode === null ? " (killed by a signal)" : ` with exit code ${exitCode}`}${
            detail ? `: ${detail}` : ""
          }`,
          { args, stderr: result.stderr, exitCode: exitCode ?? undefined },
        ),
      );
    });
  });
}
