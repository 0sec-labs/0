"""Real adaptive local model/target; retained CLI and PTY reads perform no network calls."""
import base64, errno, fcntl, hashlib, http.server, json, os, pty, re, select, signal, sqlite3, struct, subprocess, sys, termios, threading, time
config=json.load(open(sys.argv[1],encoding='utf8'));root=config['root'];binary=config['binary'];state=os.path.join(root,'state.db')
models=[];targets=[];errors=[]
def digest(data):return 'sha256:'+hashlib.sha256(data).hexdigest()
def proposal(expected,prior=None):
 hypothesis={'title':'Adaptive conjecture λ <script>model</script>','explanation':'Model prediction is not independently established security truth'}
 if prior:hypothesis['prior_revision']={'operation_id':prior['experiment_operation_id'],'hypothesis_sha256':prior['hypothesis']['hypothesis_sha256']}
 return {'hypothesis':hypothesis,'purpose':'Observe feedback, revise prediction, then stop early','repeats':2,'cases':[{'name':'attack','role':'attack','request':{'url':'/target/attack'},'expected':{'status':200,'body_sha256':expected}},{'name':'control','role':'legitimate_control','request':{'url':'/target/control'},'expected':{'status':200,'body_sha256':digest(b'control')}}]}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   data=self.rfile.read(int(self.headers.get('Content-Length','0')))
   if self.path.startswith('/target/'):
    targets.append(self.path);body={'/target/attack':b'measured attack','/target/control':b'control'}[self.path]
    self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
   request=json.loads(data);models.append(request)
   assert any(t['name']=='run_web_experiment' for t in request['tools'])
   assert not any(t['name'] in ('execute_snapshot','submit_web_hypotheses') for t in request['tools'])
   if len(models)==1:args=proposal(digest(b'model guessed wrong'))
   else:
    raw=[v['output'] for v in request['input'] if v.get('type')=='function_call_output']
    assert all(value.startswith('{') for value in raw),('experiment rejected before independent feedback',raw)
    feedback=[json.loads(value) for value in raw]
    assert len(feedback)==len(models)-1,feedback
    latest=feedback[-1]
    assert latest['vulnerability_reportable'] is False and latest['evolution_eligible'] is False
    if len(models)==2:
     assert latest['assessment']['disposition']=='not_observed',latest
     measurement=next(a for a in latest['attempts'] if a['case_name']=='attack')
     assert measurement['body_sha256']!=digest(b'model guessed wrong')
     args=proposal(measurement['body_sha256'],latest)
    else:
     assert len(models)==3 and latest['assessment']['disposition']=='observed_for_plan',latest
     assert len(targets)==8,targets
     output=[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'Stopped after two experiments; no vulnerability conclusion.'}]}]
   if len(models)<3:output=[{'type':'function_call','call_id':'experiment-'+str(len(models)),'name':'run_web_experiment','arguments':json.dumps(args)}]
   event={'type':'response.completed','response':{'id':'adaptive-'+str(len(models)),'status':'completed','output':output,'usage':{'input_tokens':2,'output_tokens':1}}}
   body=('data: '+json.dumps(event)+'\n\n').encode();self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except BaseException as error:errors.append(repr(error));raise
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True;threading.Thread(target=server.serve_forever,daemon=True).start()
providers=os.path.join(root,'providers.json');profiles=os.path.join(root,'http.json');request_file=os.path.join(root,'request.json')
policy=config['policy'];policy['base_url']='http://127.0.0.1:%d/target/'%server.server_port;policy['rate']['default']['burst']=20;policy['rate']['default']['requests_per_interval']=100
json.dump({'target':{'policy':policy}},open(profiles,'w'))
json.dump({'fixture':{'url':'http://127.0.0.1:%d/responses'%server.server_port,'api_key_env':'EXPERIMENT_KEY','rates':{'input':1000000,'cached_input':0,'output':1000000},'timeout_ms':5000,'max_response_bytes':65536}},open(providers,'w'))
json.dump({'provider':'fixture','model':'fixture','instructions':'Choose experiments within host limits and stop when appropriate','prompt':'Investigate adaptively and stop early','http_profile':'target','web_experiment_policy':{'schema_version':1,'max_experiments':3,'max_cases':2,'max_repeats':2},'max_turns':5,'reservation_per_turn':10},open(request_file,'w'))
env=os.environ.copy();env.update(EXPERIMENT_KEY='local-experiment-secret',TERM='xterm-256color');common=[binary,'--state',state]
def run(args,configured=False,parsed=True):
 result=subprocess.run(common+(['--providers',providers,'--http-profiles',profiles] if configured else [])+args,env=env,capture_output=True,timeout=20)
 assert result.returncode==0,(args,result.returncode,result.stderr.decode(),result.stdout.decode(),errors)
 assert not errors,errors
 return json.loads(result.stdout) if parsed else result.stdout.decode()
def web(command,extra=[]):return run(['web',command,'--session',session,'--operation',operation]+extra)
def query(sql):
 with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:return db.execute(sql).fetchall()
try:
 session=run(['session','create','--budget-limit','100'])['session']['id']
 agent=['agent','--session',session,'--command-id','adaptive','--request',request_file]
 seeded=run(agent,True);operation=seeded['operation']['id']
 assert seeded['result']['status']=='completed' and seeded['result'].get('web_review') is None,seeded
 assert len(models)==3 and len(targets)==8,(len(models),targets)
 page=web('experiments')['page'];assert len(page['experiments'])==2,page
 first,second=[v['operation_id'] for v in page['experiments']]
 a=web('experiment',['--experiment',first])['experiment'];b=web('experiment',['--experiment',second])['experiment']
 assert a['outcome']['assessment']['disposition']=='not_observed' and b['outcome']['assessment']['disposition']=='observed_for_plan'
 assert b['hypothesis']['prior_revision']=={'operation_id':first,'hypothesis_sha256':a['hypothesis']['hypothesis_sha256']}
 assert len(query("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='agent_web_experiment'"))==2
 server.shutdown();server.server_close();os.unlink(profiles)
 retry=subprocess.run(common+['--providers',providers]+agent,env=env,capture_output=True,timeout=15)
 assert retry.returncode==0,retry.stderr;assert json.loads(retry.stdout)['duplicate'] is True
 os.unlink(providers);env.pop('EXPERIMENT_KEY')
 links=['--experiment',first,'--experiment',second]
 report=web('report',links);assert len(report['experiments'])==2 and report['verification_state']=='unverified' and report['run']['review'] is None
 assert len(report['observations'])==8,report['observations']
 assert report['experiments'][1]['outcome']['assessment']['vulnerability_reportable'] is False
 for format in ('html','markdown'):
  output=run(['web','report','--session',session,'--operation',operation]+links+['--format',format],parsed=False)
  assert 'Model predictions' in output and 'Independent measured feedback' in output
  assert '<script>model</script>' not in output
 attempt=b['outcome']['attempts'][0]
 evidence=run(['web','range','--session',session,'--operation',attempt['operation_id'],'--expected-manifest',attempt['response_manifest_sha256'],'--limit','100'])['range']
 assert base64.b64decode(evidence['data_base64'])==b'measured attack'
 assert len(models)==3 and len(targets)==8
except BaseException:
 server.shutdown();server.server_close();raise

if config['mode']=='cli':raise SystemExit(0)
before_operations=query("SELECT id,status,payload_hash,outcome FROM operations ORDER BY id")
before_artifacts=query("SELECT digest,length(bytes) FROM artifacts ORDER BY digest")
master,slave=pty.openpty();original=termios.tcgetattr(slave)
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',38,140,0,0))
screen=bytearray();proc=None;children=[];handles=[]
def pump(seconds=0.03):
    if select.select([master], [], [], seconds)[0]:
        try:
            screen.extend(os.read(master, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    assert len(screen) < 8 * 1024 * 1024


def until(predicate, label, seconds=8):
    end = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < end, "timeout: " + label
        assert proc.poll() is None, "premature exit: " + label
        pump()


def send(text):
    os.write(master, text.encode())


def visible(text):
    # Ratatui writes cell differences, so a title need not occur contiguously in
    # the byte stream. Reconstruct the fixed fixture screen's cursor writes.
    until(lambda: text in terminal_text(), text)


def terminal_text():
    cells = [[" "] * 140 for _ in range(38)]
    row = column = 0
    for token in re.findall(r"\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+", screen.decode("utf-8", "ignore")):
        if token.startswith("\x1b["):
            body, code = token[2:-1], token[-1]
            if body.startswith("?") or code == "m":
                continue
            values = [int(v) if v else 0 for v in body.split(";")]
            n = values[0] or 1
            if code in ("H", "f"):
                row = max(0, values[0] - 1)
                column = max(0, (values[1] if len(values) > 1 else 1) - 1)
            elif code == "J" and values[0] in (2, 3):
                cells = [[" "] * 140 for _ in range(38)]
            elif code == "K" and row < 38:
                start, end = (0, 140) if values[0] == 2 else ((0, column + 1) if values[0] == 1 else (column, 140))
                for col in range(start, min(end, 140)):
                    cells[row][col] = " "
            elif code == "A":
                row = max(0, row - n)
            elif code == "B":
                row += n
            elif code == "C":
                column += n
            elif code == "D":
                column = max(0, column - n)
            continue
        for char in token:
            if char == "\r":
                column = 0
            elif char == "\n":
                row += 1
            elif char >= " ":
                if row < 38 and column < 140:
                    cells[row][column] = char
                column += 1
    return "\n".join("".join(line) for line in cells)

try:
 proc=subprocess.Popen(common+['tui','--session',session],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
 visible('Investigate adaptively and stop early');visible('9 charged / 0 reserved')
 with open('/proc/%d/task/%d/children'%(proc.pid,proc.pid)) as file:children=[int(v) for v in file.read().split()]
 handles=[os.pidfd_open(v) for v in children];assert children
 send('\t\t\t');visible('Web runs');visible(operation);send('\r');visible('Web run — partial')
 send('x');visible('Agent experiments');visible(first);send('\x1b[B');send('\r');visible('Model conjecture');visible(second)
 visible('Independent measured feedback');send('e');visible('Retained HTTP evidence');visible('measured attack')
 send('\x1b');visible('Model conjecture');send('p');visible(first);visible('NotObserved')
 send('\x1b[200~approve\n<untrusted>\x1b[201~');send('\r');send('\x13')
 for _ in range(5):pump()
 assert query("SELECT id,status,payload_hash,outcome FROM operations ORDER BY id")==before_operations
 send('\x11')
 end=time.monotonic()+10
 while proc.poll() is None:
  assert time.monotonic()<end,'TUI shutdown deadline';pump()
 for _ in range(4):pump(.01)
 assert proc.returncode==0,(proc.returncode,terminal_text())
 assert termios.tcgetattr(slave)==original
 assert b'\x1b[?1049h' in screen and b'\x1b[?1049l' in screen
 assert not any(os.path.exists('/proc/%d'%v) for v in children)
 assert len(models)==3 and len(targets)==8
 assert query("SELECT digest,length(bytes) FROM artifacts ORDER BY digest")==before_artifacts
except Exception:
 sys.stderr.write(terminal_text()+'\n');raise
finally:
 if proc is not None and proc.poll() is None:
  for handle in handles:
   try:signal.pidfd_send_signal(handle,signal.SIGKILL)
   except ProcessLookupError:pass
  os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
 for handle in handles:os.close(handle)
 os.close(master);os.close(slave)
