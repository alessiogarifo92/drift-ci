// Best-effort lookup of the GitHub repository a checkout came from, so same-repo
// github.com URLs in docs can be read as paths. Absence is normal, never an error.
import { GitError } from "./errors.ts";
import { runGit, type GitOptions } from "./run.ts";

const GITHUB_REMOTE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[\w.-]+@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** `owner` and `name` of a github.com remote URL (https, ssh, git or scp-style), else `undefined`. */
export function parseGitHubRemote(
  url: string,
): { owner: string; name: string } | undefined {
  const match = GITHUB_REMOTE.exec(url.trim());
  const owner = match?.[1];
  const name = match?.[2];
  return owner === undefined || name === undefined
    ? undefined
    : { owner, name };
}

/** The GitHub repository behind the `origin` remote of `repoDir`, or `undefined` for any reason it cannot be known. */
export async function readRepoSlug(
  repoDir: string,
  options: GitOptions = {},
): Promise<{ owner: string; name: string } | undefined> {
  try {
    const { stdout } = await runGit(
      repoDir,
      ["remote", "get-url", "origin"],
      options,
    );
    return parseGitHubRemote(stdout.toString("utf8"));
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}
