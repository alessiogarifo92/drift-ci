// The rules a default run uses. Each rule ticket adds its factory here.
import type { Rule } from '../rules.ts';
import { binRule } from './bin.ts';
import { envRule } from './env.ts';
import { makeTargetRule } from './make.ts';
import { pathRule } from './path.ts';
import { npmScriptRule } from './scripts.ts';

/** Fresh rule instances (rules hold per-run state). */
export function defaultRules(): Rule[] {
  return [pathRule(), npmScriptRule(), binRule(), makeTargetRule(), envRule()];
}
