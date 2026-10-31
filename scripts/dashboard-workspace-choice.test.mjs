import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
test('external workspace actions retain one validated team form and remove duplicate primary buttons', async () => {
  const dashboard = resolve(root, 'packages/dashboard');
  const directory = await mkdtemp(resolve(dashboard, '.workspace-choice-test-'));
  try {
    const output = resolve(directory, 'fixture.mjs');
    await build({ stdin: { contents: `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {WorkspaceChoice} from './src/components/workspace-choice';export const render=props=>renderToStaticMarkup(React.createElement(WorkspaceChoice,{onContinue:()=>{},externalActions:true,...props}));`, resolveDir: dashboard, loader: 'tsx' }, outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', alias: { '@': resolve(dashboard, 'src') }, logLevel: 'silent' });
    const { render } = await import(pathToFileURL(output).href);
    const team = render({ initialMode: 'team' });
    assert.equal((team.match(/<form\b/g) || []).length, 1);
    assert.match(team, /type="password"[^>]*minLength="12"[^>]*required=""/);
    assert.doesNotMatch(team, />Create team workspace</);
    const solo = render({ initialMode: 'personal' });
    assert.doesNotMatch(solo, /Use Solo workspace|type="submit"/);
    const existing = render({ teamName: 'Example team' });
    assert.match(existing, /Signed in to Example team/);
    assert.doesNotMatch(existing, /<button|<form/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
