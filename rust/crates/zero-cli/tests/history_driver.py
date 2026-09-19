"""Reuse physical scan production paths, then inspect with no source configuration or servers."""
import csv
import io
import json
import os
import runpy
import sqlite3
import subprocess
import sys

binary, root = sys.argv[1:]
# This fixture performs actual native runs and deletes every profile/credential,
# then closes both loopback servers before returning its retained identities.
fixture = runpy.run_path(os.path.join(os.path.dirname(__file__), 'scan_driver.py'))
state = os.path.join(root, 'state.db')
before = open(state, 'rb').read()

def call(args):
    out = subprocess.run([binary, '--state', state, '--providers', '/missing/providers',
                          '--http-profiles', '/missing/http', '--harness-config', '/missing/harness'] + args,
                         capture_output=True, timeout=10)
    assert out.returncode == 0, (args, out.returncode, out.stdout, out.stderr)
    assert b'target-private-token' not in out.stdout + out.stderr
    return out.stdout.decode()

ids = []
cursor = None
pages = []
while True:
    args = ['history', '--limit', '2', '--format', 'json']
    if cursor is not None:
        args += ['--before-sequence', str(cursor)]
    page = json.loads(call(args))['page']
    pages += page['scans']
    ids += [row['scan']['id'] for row in page['scans']]
    next_cursor = page['next_before_sequence']
    if next_cursor is None:
        break
    assert cursor is None or next_cursor < cursor
    cursor = next_cursor
assert len(ids) == len(set(ids)) == 6, ids
assert [row['scan']['sequence'] for row in pages] == sorted([row['scan']['sequence'] for row in pages], reverse=True)
with sqlite3.connect('file:' + state + '?mode=ro', uri=True) as db:
    expected = [json.loads(row[0])['id'] for row in db.execute('select record from scans order by sequence desc')]
assert ids == expected
held = [row for row in pages if row['budget']['reserved'] == 10]
assert len(held) == 2 and {row['close_reason'] for row in held} == {'cancelled', 'deadline'}
assert any(row['result']['outcome']['completeness'] == 'partial' for row in pages)
assert any(row['result']['outcome']['summary']['submitted_hypotheses'] == 0 for row in pages)
text = call(['history'])
assert 'Claims remain unverified' in text and 'held=10' in text and 'Partial' in text
assert 'response_held_bytes=' in text and 'micro-USD' in text

selected = fixture['id']
session = fixture['scan']['scan']['session_id']
events = []
cursor = 0
while True:
    page = json.loads(call(['timeline', selected, '--after-sequence', str(cursor), '--limit', '3', '--format', 'json']))
    assert page['session_id'] == session and page['scan_id'] == selected
    events += page['events']
    if not page['events']:
        assert page['next_after_sequence'] is None
        break
    assert page['next_after_sequence'] > cursor
    cursor = page['next_after_sequence']
with sqlite3.connect('file:' + state + '?mode=ro', uri=True) as db:
    expected = [(row[0], row[1], json.loads(row[2])) for row in db.execute(
        'select sequence,kind,payload from events where session_id=? order by sequence', (session,))]
assert [(e['sequence'], e['kind'], e['payload']) for e in events] == expected
assert any(e['kind'] == 'scan_created' for e in events)
markdown = call(['timeline', selected])
assert 'never replays effects' in markdown and 'not recorded here' in markdown
rows = list(csv.DictReader(io.StringIO(call(['timeline', selected, '--format', 'csv']))))
assert rows and all(row['session_id'] == session for row in rows)
assert open(state, 'rb').read() == before, 'read-only exports changed the database'
