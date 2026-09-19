"""Native local-review history with actual model transport and retained selected source."""
import http.server
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading

binary, root = sys.argv[1:]
source = os.path.join(root, 'source')
os.mkdir(source)
os.makedirs(os.path.join(source, '.0sec', 'native'))
open(os.path.join(source, 'app.rs'), 'w').write('fn main() { println!("history"); }\n')
open(os.path.join(source, '.0sec', 'native', 'notes.rs'), 'w').write('// retain this adjacent file\n')
state = os.path.join(source, '.0sec', 'native', 'state.db')
profiles = os.path.join(root, 'reviews.json')
providers = os.path.join(root, 'providers.json')
calls = []
errors = []
held = threading.Event()
release = threading.Event()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(request)
            assert self.path == '/responses'
            if 'HOLD' in request['instructions']:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"waiting"}\n\n')
                self.wfile.flush()
                held.set()
                release.wait(20)
                return
            assert any(tool['name'] == 'submit_source_hypotheses' for tool in request['tools'])
            output = [{'type':'function_call','call_id':'submit','name':'submit_source_hypotheses',
                       'arguments':json.dumps({'selected_files':['app.rs'], 'hypotheses':[]})}]
            event = {'type':'response.completed','response':{'id':'r'+str(len(calls)), 'status':'completed',
                     'output':output,'usage':{'input_tokens':2,'cached_input_tokens':0,'output_tokens':1}}}
            body = ('data: '+json.dumps(event)+'\n\n').encode()
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except BaseException as error:
            errors.append(repr(error))
            raise

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
json.dump({'p':{'url':'http://127.0.0.1:'+str(server.server_port)+'/responses','api_key_env':'REVIEW_HISTORY_KEY',
          'rates':{'input':1000000,'cached_input':0,'output':1000000},'timeout_ms':20000,'max_response_bytes':65536}},open(providers,'w'))
base = {'schema_version':1,'provider':'p','model':'fixture','instructions':'Submit a bounded source review',
        'question':'Inspect only retained source','execution':{'backend':{'type':'docker','image':'sha256:'+'a'*64},
        'timeout_ms':1000,'memory_mb':128,'cpus':1,'max_output_bytes':4096},'budget_limit':100,'currency':'units',
        'reservation_per_turn':10,'max_turns':4,'max_hypotheses':4,'deadline_ms':60000}
json.dump({'local':base, 'held':dict(base,instructions='HOLD provider for cancellation')},open(profiles,'w'))
env = dict(os.environ, REVIEW_HISTORY_KEY='private-history-key')
common = [binary,'--state',state,'--review-profiles',profiles,'--providers',providers]

def run(args, code=0, as_text=False):
    out = subprocess.run(common+args,env=env,cwd=source,capture_output=True,timeout=15)
    assert out.returncode == code, (args,out.returncode,out.stdout,out.stderr,errors)
    assert not errors, errors
    assert b'private-history-key' not in out.stdout+out.stderr
    return out.stdout.decode() if as_text else json.loads(out.stdout)

def review(command, profile='local'):
    return ['review','.','--profile',profile,'--command-id',command,'--format','json']

owner = None
try:
    first = run(review('first'))['review']
    second = run(review('second'))['review']
    assert first['review']['snapshot_sha256'] == second['review']['snapshot_sha256']
    owner = subprocess.Popen(common+review('held','held'),env=env,cwd=source,stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert held.wait(10), 'provider was not admitted'
    live = run(['history','--kind','review','--limit','1','--format','json'])
    assert live['schema_version'] == 1 and live['kind'] == 'review'
    row = live['page']['reviews'][0]
    assert row['root_status'] == 'running' and row['controller_status'] == 'running', row
    assert row['budget']['reserved'] == 10 and row['review']['command_id'] == 'held'
    assert 'agent_result' not in row
    scope = row['review']['workspace_selection']
    assert scope['original_root'] == os.path.realpath(source)
    assert scope['policy'] == {'kind':'exclude_native_state','state_relative_path':'.0sec/native/state.db'}
    assert len(scope['exclusions']) == 5 and scope['file_count'] == 2
    held_id = row['review']['id']
    owner.send_signal(signal.SIGTERM)
    stdout, stderr = owner.communicate(timeout=15)
    assert owner.returncode == 143, (owner.returncode,stdout,stderr)
    release.set()
    owner = None
    os.unlink(profiles)
    os.unlink(providers)
    os.unlink(os.path.join(source,'app.rs'))
    os.unlink(os.path.join(source,'.0sec','native','notes.rs'))
    env.pop('REVIEW_HISTORY_KEY')
    before = open(state,'rb').read()
    count = len(calls)
    seen = []
    cursor = None
    while True:
        args = ['history','--kind','review','--limit','1','--format','json']
        if cursor is not None:
            args += ['--before-sequence',str(cursor)]
        page = run(args)['page']
        seen += page['reviews']
        following = page['next_before_sequence']
        if following is None:
            break
        assert cursor is None or following < cursor
        cursor = following
    assert [row['review']['id'] for row in seen] == [held_id,second['review']['id'],first['review']['id']]
    assert seen[0]['budget']['reserved'] == 10 and seen[0]['close_reason'] == 'cancelled'
    assert all(row['review']['workspace_selection'] == scope for row in seen)
    text = run(['history','--kind','review'],as_text=True)
    assert 'held=10' in text and 'Claims remain unverified' in text
    assert 'workspace='+os.path.realpath(source) in text
    assert 'configured exclusion rules (including absent paths)' in text
    assert 'files=2' in text and 'review report --review '+held_id in text
    # Default HTTP discovery must not mix local reviews into its old page shape.
    assert run(['history','--format','json'])['page']['scans'] == []
    assert len(calls) == count and open(state,'rb').read() == before
    with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:
        assert db.execute("select count(*) from operations where status='running'").fetchone()[0] == 0
finally:
    release.set()
    if owner is not None:
        owner.kill()
        owner.communicate(timeout=10)
    server.shutdown()
    server.server_close()
