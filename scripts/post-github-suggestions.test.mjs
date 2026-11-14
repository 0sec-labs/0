import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {rightLinesByHunk, rangeInDiff, planComments, commentBody, main} from './post-github-suggestions.mjs';

const SHA = 'a'.repeat(40);
// New-file lines: 10 context, 11 added, 12 added, 13 context; second hunk starts at 40.
const PATCH = '@@ -10,3 +10,4 @@ fn\n ctx\n+added one\n+added two\n ctx2\n@@ -40,2 +40,2 @@\n-old\n+new\n same';
const finding = (over = {}, annotation = {}) => ({
  id: 'f-1', title: 'Path traversal', severity: 'high', description: 'User input reaches fs.',
  reviewAnnotation: {path: 'src/a.ts', startLine: 11, suggestion: 'safe();', ...annotation}, ...over,
});
const files = new Map([['src/a.ts', {filename: 'src/a.ts', patch: PATCH}]]);

test('diff line map ignores deleted lines and keeps hunks separate', () => {
  const hunks = rightLinesByHunk(PATCH);
  assert.deepEqual([...hunks[0]], [10, 11, 12, 13]);
  assert.deepEqual([...hunks[1]], [40, 41]);
  assert.equal(rangeInDiff(hunks, 11, 12), true);
  assert.equal(rangeInDiff(hunks, 13, 40), false, 'a range may not span hunks');
  assert.equal(rangeInDiff(hunks, 20, 20), false);
});

test('plans a single-line and a multi-line suggestion with GitHub anchors', () => {
  const {comments, skipped} = planComments({findings: [
    finding(),
    finding({id: 'f-2'}, {startLine: 11, endLine: 12, suggestion: 'a();\nb();\n'}),
  ]}, files, []);
  assert.equal(skipped.length, 0);
  assert.deepEqual({...comments[0], body: undefined}, {path: 'src/a.ts', line: 11, side: 'RIGHT', body: undefined});
  assert.equal(comments[1].start_line, 11); assert.equal(comments[1].line, 12); assert.equal(comments[1].start_side, 'RIGHT');
  assert.match(comments[1].body, /```suggestion\na\(\);\nb\(\);\n```/);
  assert.match(comments[0].body, /has not been run or tested/);
});

test('skips lines outside the diff, unchanged files, bad locations, duplicates and over-limit', () => {
  const existing = [commentBody(finding({id: 'dup'}), {path: 'src/a.ts', startLine: 11, suggestion: 'x'})];
  const {comments, skipped} = planComments({findings: [
    finding({id: 'out'}, {startLine: 30}),
    finding({id: 'other'}, {path: 'src/other.ts'}),
    finding({id: 'bad'}, {startLine: 0}),
    finding({id: 'dup'}),
    finding({id: 'ok1'}, {startLine: 10}),
    finding({id: 'ok2'}, {startLine: 12}),
    {id: 'nofix', title: 't', severity: 'low', reviewAnnotation: {path: 'src/a.ts', startLine: 11}},
  ]}, files, existing, 1);
  assert.equal(comments.length, 1);
  assert.deepEqual(skipped.map(s => s.replace(/^\S+ /, '')), [
    'lines are not in the pull request diff', 'not changed in this pull request', 'invalid location', 'already suggested', 'over the 1 comment limit']);
});

test('untrusted report text cannot ping users, forge markers, inject HTML or break the fence', () => {
  const body = commentBody(finding({title: '<!-- 0-suggestion:evil --> @octocat [x](http://e)', description: '<img src=x> @org/team'}),
    {path: 'src/a.ts', startLine: 11, suggestion: 'const s = ```x```;'});
  assert.doesNotMatch(body.split('\n').slice(1).join('\n'), /<!--/);
  assert.doesNotMatch(body, /@octocat|@org/);
  assert.doesNotMatch(body, /<img/);
  assert.doesNotMatch(body, /\]\(/);
  assert.match(body, /^````suggestion\nconst s = ```x```;\n````$/m, 'fence is longer than any backtick run inside');
  assert.equal(body.split('\n')[0].startsWith('<!-- 0-suggestion:f-1:'), true);
});

function mockGitHub({head = SHA, status = {}} = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let data = ''; req.on('data', c => data += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x'); calls.push({method: req.method, path: url.pathname, body: data ? JSON.parse(data) : undefined, auth: req.headers.authorization});
      const forced = status[`${req.method} ${url.pathname}`];
      if (forced) { res.writeHead(forced); return res.end('{}'); }
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/repos/o/r/pulls/7') return res.end(JSON.stringify({head: {sha: head}}));
      if (url.pathname === '/repos/o/r/pulls/7/files') return res.end(JSON.stringify([{filename: 'src/a.ts', patch: PATCH}]));
      if (url.pathname === '/repos/o/r/pulls/7/comments') return res.end('[]');
      if (url.pathname === '/repos/o/r/pulls/7/reviews' && req.method === 'POST') return res.end('{"id":1}');
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({calls, close: () => server.close(), url: `http://127.0.0.1:${server.address().port}`})));
}

async function runMain({report, head, status, extra = {}}) {
  const gh = await mockGitHub({head, status});
  const dir = mkdtempSync(join(tmpdir(), '0-sugg-')); const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(report));
  const logs = [];
  try {
    const env = {INPUT_REPORT: path, GITHUB_TOKEN: 'secret-tok-123', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: gh.url, INPUT_PR_NUMBER: '7', INPUT_COMMIT_SHA: SHA, ...extra};
    let result, error;
    try { result = await main(env, m => logs.push(m)); } catch (e) { error = e; }
    return {result, error, calls: gh.calls, logs};
  } finally { gh.close(); rmSync(dir, {recursive: true, force: true}); }
}

test('posts one review with suggestion comments against the PR head', async () => {
  const r = await runMain({report: {findings: [finding(), finding({id: 'f-2'}, {startLine: 30})]}});
  assert.equal(r.error, undefined); assert.equal(r.result.posted, 1);
  const post = r.calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/repos/o/r/pulls/7/reviews'); assert.equal(post.auth, 'Bearer secret-tok-123');
  assert.equal(post.body.commit_id, SHA); assert.equal(post.body.event, 'COMMENT'); assert.equal(post.body.comments.length, 1);
  assert.equal(post.body.comments[0].line, 11);
  assert.ok(r.logs.some(l => /not in the pull request diff/.test(l)));
});

test('does nothing when the head moved on, when nothing qualifies, and in dry-run', async () => {
  const stale = await runMain({report: {findings: [finding()]}, head: 'b'.repeat(40)});
  assert.equal(stale.result.posted, 0); assert.equal(stale.calls.some(c => c.method === 'POST'), false);
  const none = await runMain({report: {findings: [{id: 'x', title: 't', severity: 'low'}]}});
  assert.equal(none.calls.some(c => c.method === 'POST'), false); assert.ok(none.logs.includes('No suggestions to post.'));
  const dry = await runMain({report: {findings: [finding()]}, extra: {INPUT_DRY_RUN: 'true'}});
  assert.equal(dry.result.dryRun, true); assert.equal(dry.calls.some(c => c.method === 'POST'), false);
});

test('a read-only token (fork pull request) fails with a clear message and leaks no secret', async () => {
  const r = await runMain({report: {findings: [finding()]}, status: {'POST /repos/o/r/pulls/7/reviews': 403}});
  assert.match(r.error.message, /pull-requests: write.*forks/); assert.doesNotMatch(r.error.message, /secret-tok-123/);
});

test('rejects missing configuration and unreadable reports', async () => {
  await assert.rejects(main({}, () => {}), /Set INPUT_REPORT/);
  const bad = await runMain({report: {}, extra: {INPUT_COMMIT_SHA: 'nope'}});
  assert.match(bad.error.message, /head commit sha/);
});
