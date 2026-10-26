import { OUTPUT_FORMATS, runCheckCommand, type CheckCommandOptions, type OutputFormat } from './check.ts';
import type { Io } from './io.ts';

declare const __DRIFT_CI_VERSION__: string | undefined;

export const VERSION =
  typeof __DRIFT_CI_VERSION__ === 'string' ? __DRIFT_CI_VERSION__ : '0.0.0-dev';

const HELP = `Usage: drift-ci [check] [options]

Checks docs and AI-agent context files for references to things renamed or
removed between two commits. \`check\` is the only command; it is the default.

Options:
  --base <ref>       Base commit (default: HEAD^)
  --head <ref>       Head commit (default: HEAD)
  --cwd <dir>        Repository directory (default: current directory)
  --format <format>  Output format: text or json (default: text)
  -h, --help         Show this help
  -v, --version      Show the version
`;

export type { Io };

export type Options = CheckCommandOptions;

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: Options }
  | { kind: 'error'; message: string };

export function parseArgs(argv: readonly string[], defaultCwd: string): Parsed {
  const options: Options = { base: 'HEAD^', head: 'HEAD', cwd: defaultCwd, format: 'text' };
  const args = argv[0] === 'check' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { kind: 'help' };
      case '-v':
      case '--version':
        return { kind: 'version' };
      case '--base':
      case '--head':
      case '--cwd':
      case '--format': {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('-')) {
          return { kind: 'error', message: `${arg} needs a value` };
        }
        if (arg === '--format') {
          if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
            return { kind: 'error', message: `unknown format: ${value} (expected json or text)` };
          }
          options.format = value as OutputFormat;
        } else {
          options[arg.slice(2) as 'base' | 'head' | 'cwd'] = value;
        }
        i++;
        break;
      }
      default:
        return { kind: 'error', message: `unknown argument: ${String(arg)}` };
    }
  }
  return { kind: 'run', options };
}

/** Runs the CLI and returns the process exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
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
    case 'run':
      return runCheckCommand(parsed.options, io);
  }
}
