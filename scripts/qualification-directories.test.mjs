import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withQualificationDirectories } from '../docs/qualification/qualification-directories.mjs';

async function fixture(run) {
 const root = await mkdtemp(join(tmpdir(), '0-qualification-cleanup-test-'));
 try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('setup failure removes scratch even before the runner enters its report try/finally', async () => {
 await fixture(async root => {
  await assert.rejects(withQualificationDirectories(root, async directories => {
   const workspace = await directories.scratch('source-');
   await writeFile(join(workspace, 'fixture'), 'fixture');
   throw new Error('scope approval failed during setup');
  }), /scope approval failed/);
  assert.deepEqual(await readdir(root), []);
 });
});

test('failed report write removes scratch and retains debugging artifacts', async () => {
 await fixture(async root => {
  let artifact;
  await assert.rejects(withQualificationDirectories(root, async directories => {
   await directories.scratch('workspace-');
   artifact = await directories.artifacts('artifacts-');
   await writeFile(join(artifact, 'guest-output'), 'diagnostics');
   await writeFile(join(root, 'missing-parent', 'report.json'), '{}');
  }), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), [artifact.split('/').at(-1)]);
 });
});

test('passing runs remove scratch and artifacts while preserving the durable report', async () => {
 await fixture(async root => {
  const result = await withQualificationDirectories(root, async directories => {
   await directories.scratch('workspace-');
   await directories.artifacts('artifacts-');
   await writeFile(join(root, 'report.json'), '{"outcome":"passed"}');
   directories.passed();
   return 'passed';
  }, { keepArtifacts: false });
  assert.equal(result, 'passed');
  assert.deepEqual(await readdir(root), ['report.json']);
 });
});

test('explicit artifact retention never retains scratch', async () => {
 await fixture(async root => {
  let artifact;
  await withQualificationDirectories(root, async directories => {
   await directories.scratch('workspace-');
   artifact = await directories.artifacts('artifacts-');
   directories.passed();
  }, { keepArtifacts: true });
  assert.deepEqual(await readdir(root), [artifact.split('/').at(-1)]);
 });
});

test('a late failure overrides an earlier pass signal for artifact retention', async () => {
 await fixture(async root => {
  let artifact;
  await assert.rejects(withQualificationDirectories(root, async directories => {
   await directories.scratch('workspace-');
   artifact = await directories.artifacts('artifacts-');
   directories.passed();
   throw new Error('late report failure');
  }, { keepArtifacts: false }), /late report failure/);
  assert.deepEqual(await readdir(root), [artifact.split('/').at(-1)]);
 });
});
