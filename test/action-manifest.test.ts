// action.yml and the workflows are parsed by GitHub before any of our code runs:
// a YAML error there breaks every consumer, so they are checked here.
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('action.yml', () => {
  const manifest = parse(read('action.yml')) as {
    name: string;
    inputs: Record<string, { description: string; default?: string }>;
    runs: { using: string; main: string };
  };

  it('is valid YAML with the node24 runtime and the bundled entry point', () => {
    expect(manifest.name).toBe('Drift CI');
    expect(manifest.runs).toEqual({ using: 'node24', main: 'dist/action.js' });
  });

  it('declares every input the action reads, each with a description', () => {
    expect(Object.keys(manifest.inputs).sort()).toEqual(['comment', 'config', 'fail-on', 'github-token']);
    for (const input of Object.values(manifest.inputs)) expect(input.description).toEqual(expect.any(String));
    expect(manifest.inputs['github-token']?.default).toBe('${{ github.token }}');
  });
});

describe('workflows', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  it.each(readdirSync(dir).filter((f) => f.endsWith('.yml')))('%s is valid YAML', (file) => {
    expect(() => parse(readFileSync(new URL(file, dir), 'utf8'))).not.toThrow();
  });
});
