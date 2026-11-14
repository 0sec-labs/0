import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../packages/web/src/${path}`, import.meta.url), 'utf8');

test('live page URL inputs have accessible names', () => {
  const source = read('pages/live-page.tsx');
  assert.match(source, /aria-label="Probe events URL"/);
  assert.match(source, /aria-label="Agent events URL"/);
});

test('mobile navigation sheet describes itself to assistive technology', () => {
  assert.match(read('components/shared-workspace-layout.tsx'), /<SheetDescription/);
});
