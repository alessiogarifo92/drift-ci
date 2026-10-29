import { GitError, UnknownRevisionError } from "./errors.ts";
import { runGit, type GitOptions } from "./run.ts";

/**
 * Resolves a SHA, ref or abbreviation to a full commit SHA. `--end-of-options`
 * makes a revision that starts with a dash a revision, never a git option.
 *
 * Rejects with `UnknownRevisionError` when `rev` is not a commit of the repository
 * (in a shallow clone: when it lies beyond the fetched depth).
 */
export async function resolveCommit(
  repoDir: string,
  rev: string,
  options: GitOptions = {},
): Promise<string> {
  try {
    const { stdout } = await runGit(
      repoDir,
      ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
      options,
    );
    return stdout.toString("utf8").trim();
  } catch (error) {
    // "Needed a single revision" is git's answer for any name it cannot resolve;
    // other fatal errors (not a repository, corrupt repository) stay plain GitErrors.
    if (
      error instanceof GitError &&
      error.exitCode === 128 &&
      /Needed a single revision/.test(error.stderr)
    ) {
      throw new UnknownRevisionError(rev, {
        args: error.args,
        stderr: error.stderr,
        exitCode: error.exitCode,
      });
    }
    throw error;
  }
}

/**
 * The top-level directory of the work tree that contains `dir`. Snapshots, change sets and hunks
 * run git in the directory they are given, and `git grep <commit>` there only searches that
 * subdirectory, so callers resolve the top level first. A bare repository has no work tree and
 * is its own root.
 */
export async function repositoryRoot(
  dir: string,
  options: GitOptions = {},
): Promise<string> {
  try {
    const { stdout } = await runGit(
      dir,
      ["rev-parse", "--show-toplevel"],
      options,
    );
    return stdout.toString("utf8").replace(/\r?\n$/, "");
  } catch (error) {
    if (
      error instanceof GitError &&
      error.exitCode === 128 &&
      /work ?tree/i.test(error.stderr)
    )
      return dir;
    throw error;
  }
}
