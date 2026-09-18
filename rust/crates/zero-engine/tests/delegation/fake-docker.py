#!/usr/bin/python3
"""Concurrent lifecycle fixture only. Does not execute guest argv or prove isolation."""
import fcntl
import hashlib
import json
import os
import pathlib
import sys
import time

root = pathlib.Path(__file__).resolve().parent
containers = root / 'containers'
containers.mkdir(exist_ok=True)
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    fcntl.flock(log, fcntl.LOCK_EX)
    log.write(json.dumps(args) + '\n')
    log.flush()
scenario = (root / 'scenario').read_text().strip()
if args[:2] == ['image', 'inspect']:
    print('sha256:' + 'a' * 64)
elif args[0] == 'create':
    name = args[args.index('--name') + 1]
    identity = hashlib.sha256(name.encode()).hexdigest()
    mount = args[args.index('--mount') + 1]
    source = next(piece.removeprefix('src=') for piece in mount.split(',') if piece.startswith('src='))
    record = {'id': identity, 'name': name, 'source': source, 'snapshot': (pathlib.Path(source) / 'file.txt').read_text()}
    (containers / (identity + '.json')).write_text(json.dumps(record))
    print(identity)
elif args[0] == 'start':
    identity = args[-1]
    (root / ('started-' + identity)).write_text('started')
    print('child fixture output', flush=True)
    if scenario in ['hold', 'cleanup-fail']:
        time.sleep(60)
elif args[0] == 'rm':
    identity = args[-1]
    matches = [p for p in containers.glob('*.json') if p.stem == identity or json.loads(p.read_text())['name'] == identity]
    if not matches:
        sys.exit(1)
    for path in matches:
        identity = path.stem
        (root / ('cleanup-entered-' + identity)).write_text('entered')
        if scenario == 'cleanup-fail':
            sys.exit(1)
        if scenario == 'hold':
            while not (root / ('cleanup-release-' + identity)).exists():
                time.sleep(0.005)
        path.unlink()
        (root / ('cleaned-' + identity)).write_text('done')
        print(identity)
elif args[:2] == ['container', 'ls']:
    for path in containers.glob('*.json'):
        print(path.stem)
else:
    sys.exit(2)
