import type { FailOn } from '../core/finding.ts';
import {
  FAIL_ON_VALUES,
  OUTPUT_FORMATS,
  runCheckCommand,
  type CheckCommandOptions,
  type OutputFormat,
} from './check.ts';
import type { Io } from './io.ts';
import { runScanCommand, type ScanCommandOptions } from './scan.ts';

declare const __DRIFT_CI_VERSION__: string | undefined;

export const VERSION =
  typeof __DRIFT_CI_VERSION__ === 'string' ? __DRIFT_CI_VERSION__ : '0.0.0-dev';

const HELP = `Usage: drift-ci [check] [options]
       drift-ci scan [options]   (beta)

Checks docs and AI-agent context files for references to things renamed or
removed between two commits (\`check\`, the default), or for references that
do not exist at one commit (\`scan\`, beta: expect false positives; paths,
npm scripts and make targets only).

Options:
  --base <ref>         check: base commit (default: HEAD^)
  --head <ref>         Head commit (default: HEAD)
  --cwd <dir>          Repository directory (default: current directory)
  --format <format>    Output format: text or json (default: text)
  --fail-on <level>    none or warning: exit 1 when there are findings and
                       the level is warning (default: failOn of
                       .drift-ci.yml, else none)
  -h, --help           Show this help
  -v, --version        Show the version

Exit codes: 0 ok, 1 findings with failOn warning, 2 usage or runtime error.
`;

export type { Io };

export type Options = CheckCommandOptions;

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: Options }
  | { kind: 'scan'; options: ScanCommandOptions }
  | { kind: 'error'; message: string };

type Command = 'check' | 'scan';

/** Flags that take a value, per command. */
const VALUE_FLAGS: Record<Command, readonly string[]> = {
  check: ['--base', '--head', '--cwd', '--format', '--fail-on'],
  scan: ['--head', '--cwd', '--format', '--fail-on'],
};

export function parseArgs(argv: readonly string[], defaultCwd: string): Parsed {
  const command: Command = argv[0] === 'scan' ? 'scan' : 'check';
  const options = { base: 'HEAD^', head: 'HEAD', cwd: defaultCwd, format: 'text' as OutputFormat };
  let failOn: FailOn | undefined;
  const args = argv[0] === 'check' || argv[0] === 'scan' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') return { kind: 'help' };
    if (arg === '-v' || arg === '--version') return { kind: 'version' };
    if (arg === undefined || !VALUE_FLAGS[command].includes(arg)) {
      if (command === 'scan' && arg === '--base') {
        return { kind: 'error', message: '--base is not supported by scan (it looks at one commit)' };
      }
      return { kind: 'error', message: `unknown argument: ${String(arg)}` };
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('-')) {
      return { kind: 'error', message: `${arg} needs a value` };
    }
    if (arg === '--format') {
      if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
        return { kind: 'error', message: `unknown format: ${value} (expected json or text)` };
      }
      options.format = value as OutputFormat;
    } else if (arg === '--fail-on') {
      if (!FAIL_ON_VALUES.includes(value as FailOn)) {
        return { kind: 'error', message: `unknown --fail-on value: ${value} (expected none or warning)` };
      }
      failOn = value as FailOn;
    } else {
      options[arg.slice(2) as 'base' | 'head' | 'cwd'] = value;
    }
    i++;
  }
  const withFailOn = failOn === undefined ? {} : { failOn };
  if (command === 'scan') {
    const { head, cwd, format } = options;
    return { kind: 'scan', options: { head, cwd, format, ...withFailOn } };
  }
  return { kind: 'run', options: { ...options, ...withFailOn } };
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
    case 'scan':
      return runScanCommand(parsed.options, io);
  }
}
