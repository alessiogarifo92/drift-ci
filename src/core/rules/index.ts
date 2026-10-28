// The rules a default run uses. Each rule ticket adds its factory here.
import type { Rule } from '../rules.ts';
import { envRule } from './env.ts';
import { pathRule } from './path.ts';

/** Fresh rule instances (rules hold per-run state). */
export function defaultRules(): Rule[] {
  return [pathRule(), envRule()];
}
