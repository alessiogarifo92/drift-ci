// Typed failures of the git adapter, so callers can tell "git is not installed"
// from "that commit is not here" from "git failed".

export interface GitErrorDetails {
  /** Arguments passed to git, without the binary. */
  args?: readonly string[];
  stderr?: string;
  exitCode?: number | undefined;
  cause?: unknown;
}

/** A git command failed. */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  /** `undefined` when git did not run to completion (e.g. killed by a signal). */
  readonly exitCode: number | undefined;

  constructor(message: string, details: GitErrorDetails = {}) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "GitError";
    this.args = details.args ?? [];
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode;
  }
}

/** The git executable could not be started (spawn ENOENT). */
export class GitNotFoundError extends GitError {
  readonly gitBinary: string;

  constructor(gitBinary: string, details: GitErrorDetails = {}) {
    super(`git executable not found: ${gitBinary}`, details);
    this.name = "GitNotFoundError";
    this.gitBinary = gitBinary;
  }
}

/** A revision (SHA, ref, ...) does not resolve to a commit in the repository. */
export class UnknownRevisionError extends GitError {
  readonly rev: string;

  constructor(rev: string, details: GitErrorDetails = {}) {
    super(`unknown revision: ${rev}`, details);
    this.name = "UnknownRevisionError";
    this.rev = rev;
  }
}
