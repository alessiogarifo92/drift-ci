import { execFileSync } from 'node:child_process';
import { FINDING_SCHEMA_VERSION } from '../core/index.ts';

declare const __DRIFT_CI_VERSION__: string | undefined;

export const VERSION =
  typeof __DRIFT_CI_VERSION__ === 'string' ? __DRIFT_CI_VERSION__ : '0.0.0-dev';

const HELP = `Usage: drift-ci [options]

Checks docs and AI-agent context files for references to things renamed or
removed between two commits.

Options:
  --base <ref>   Base commit (default: HEAD^)
  --head <ref>   Head commit (default: HEAD)
  --cwd <dir>    Repository directory (default: current directory)
  -h, --help     Show this help
  -v, --version  Show the version
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

export interface Options {
  base: string;
  head: string;
  cwd: string;
}

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: Options }
  | { kind: 'error'; message: string };

export function parseArgs(argv: readonly string[], defaultCwd: string): Parsed {
  const options: Options = { base: 'HEAD^', head: 'HEAD', cwd: defaultCwd };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { kind: 'help' };
      case '-v':
      case '--version':
        return { kind: 'version' };
      case '--base':
      case '--head':
      case '--cwd': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          return { kind: 'error', message: `${arg} needs a value` };
        }
        options[arg.slice(2) as keyof Options] = value;
        i++;
        break;
      }
      default:
        return { kind: 'error', message: `unknown argument: ${String(arg)}` };
    }
  }
  return { kind: 'run', options };
}

function resolveCommit(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Runs the CLI and returns the process exit code. */
export function run(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, io.cwd);
  switch (parsed.kind) {
    case 'help':
      io.stdout(HELP);
      return 0;
    case 'version':
      io.stdout(`${VERSION}\n`);
      return 0;
    case 'error':
      io.stderr(`drift-ci: ${parsed.message}\n\n${HELP}`);
      return 2;
    case 'run': {
      const { base, head, cwd } = parsed.options;
      let baseSha: string;
      let headSha: string;
      try {
        baseSha = resolveCommit(cwd, base);
        headSha = resolveCommit(cwd, head);
      } catch (error) {
        const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
        io.stderr(`drift-ci: cannot resolve commits in ${cwd}: ${detail}\n`);
        return 2;
      }
      io.stdout(
        `drift-ci ${VERSION} (finding schema v${FINDING_SCHEMA_VERSION})\n` +
          `base ${baseSha}\nhead ${headSha}\n` +
          'No checks are implemented yet: 0 findings.\n',
      );
      return 0;
    }
  }
}
