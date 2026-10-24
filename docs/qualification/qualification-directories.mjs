import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Own allocations before canonicalization, setup, VM startup or report writes can fail. */
export async function withQualificationDirectories(root, run, { keepArtifacts = process.env.ZERO_QUALIFICATION_KEEP_ARTIFACTS === '1' } = {}) {
 const directories = [];
 let passed = false;
 let completed = false;
 async function allocate(prefix, artifact) {
  const path = await mkdtemp(join(root, prefix));
  directories.push({ path, artifact });
  return realpath(path);
 }
 try {
  const result = await run({
   scratch: prefix => allocate(prefix, false),
   artifacts: prefix => allocate(prefix, true),
   passed: () => { passed = true; },
  });
  completed = true;
  return result;
 } finally {
  // Attempt every removal even when one directory cannot be removed.
  const results = await Promise.allSettled(directories
   .filter(directory => !directory.artifact || (completed && passed && !keepArtifacts))
   .map(directory => rm(directory.path, { recursive: true, force: true })));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Qualification directory cleanup failed');
 }
}
