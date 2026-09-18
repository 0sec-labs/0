#![cfg(target_os = "linux")]
use serde_json::json;
use std::{process::Stdio, time::Duration};
#[path = "http/mod.rs"]
mod support;

#[tokio::test]
async fn executable_http_only_investigation_frozen_verification_triage_and_offline_report() {
    exercise("workflow").await;
}

#[tokio::test]
async fn console_terminal_web_review_leaves_acknowledged_followup_pending() {
    exercise("console").await;
}

async fn exercise(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("driver.json");
    std::fs::write(&config, json!({"mode":mode,"binary":env!("CARGO_BIN_EXE_0sec-native"),"root":dir.path(),"policy":support::policy("http://127.0.0.1:1/target/")}).to_string()).unwrap();
    let child = tokio::process::Command::new("python3")
        .arg("-c")
        .arg(DRIVER)
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(70), child.wait_with_output())
        .await
        .expect("bounded local web workflow")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
const DRIVER: &str = r##"
import base64,hashlib,http.server,json,os,sqlite3,subprocess,sys,threading,time
config=json.load(open(sys.argv[1],encoding='utf8'));root=config['root'];binary=config['binary'];state=os.path.join(root,'state.db')
models=[];targets=[];errors=[]
def digest(body):return 'sha256:'+hashlib.sha256(body).hexdigest()
def tool(name,args):return {'type':'function_call','call_id':name,'name':name,'arguments':json.dumps(args)}
class Target(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  targets.append(self.path);self.rfile.read(int(self.headers.get('Content-Length','0')))
  payload={'/target/fixture':b'fixture','/target/attack':b'attack','/target/control':b'control'}[self.path]
  self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
class Model(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   request=json.loads(self.rfile.read(int(self.headers['Content-Length'])));models.append(request)
   assert not any(t['name']=='execute_snapshot' for t in request['tools'])
   if len(models)==1:output=[tool('http_request',{'url':'/target/fixture'})]
   else:
    assert len(models)==2
    if config['mode']=='console':
     deadline=time.monotonic()+5
     while True:
      with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:count=db.execute('SELECT count(*) FROM agent_inputs').fetchone()[0]
      if count==2:break
      assert time.monotonic()<deadline,'second input was not durably acknowledged before terminal response'
      time.sleep(.005)
    obs=json.loads(next(v['output'] for v in request['input'] if v.get('type')=='function_call_output'))['observation']
    claim={'title':'<script>web-fixture</script>','category':'disclosure','explanation':'Fixture observation only','claimed_impact':'Requires independent host plan','claimed_severity':'low','citations':[{'operation_id':obs['operation_id'],'response_manifest_sha256':obs['response_manifest_sha256'],'part':{'type':'body','offset':0,'length':7}}]}
    output=[tool('submit_web_hypotheses',{'hypotheses':[claim]})]
   event={'type':'response.completed','response':{'id':'web-%d'%len(models),'status':'completed','output':output,'usage':{'input_tokens':2,'output_tokens':1}}}
   body=('data: '+json.dumps(event)+'\n\n').encode();self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except BaseException as e:errors.append(repr(e));raise
servers=[]
for handler in (Target,Model):
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler);server.daemon_threads=True;threading.Thread(target=server.serve_forever,daemon=True).start();servers.append(server)
target,model=servers
providers=os.path.join(root,'providers.json');profiles=os.path.join(root,'http.json');request_file=os.path.join(root,'request.json');plan_file=os.path.join(root,'plan.json')
policy=config['policy'];policy['base_url']='http://127.0.0.1:%d/target/'%target.server_port
json.dump({'target':{'policy':policy}},open(profiles,'w'))
json.dump({'fixture':{'url':'http://127.0.0.1:%d/responses'%model.server_port,'api_key_env':'WEB_FIXTURE_KEY','rates':{'input':1000000,'cached_input':0,'output':1000000},'timeout_ms':5000,'max_response_bytes':65536}},open(providers,'w'))
json.dump({'provider':'fixture','model':'fixture','instructions':'Investigate only the host target','prompt':'Submit bounded observations','http_profile':'target','web_submission_max_hypotheses':2,'max_turns':3,'reservation_per_turn':10},open(request_file,'w'))
env=os.environ.copy();env['WEB_FIXTURE_KEY']='fixture-local-only';common=[binary,'--state',state]
def run(args,config=False,json_output=True):
 cmd=common+(['--providers',providers,'--http-profiles',profiles] if config else [])+args
 result=subprocess.run(cmd,env=env,capture_output=True,timeout=15)
 assert result.returncode==0,(args,result.returncode,result.stderr.decode(),result.stdout.decode())
 assert not errors,errors
 return json.loads(result.stdout) if json_output else result.stdout.decode()
def web(cmd,operation=None,extra=[]):return run(['web',cmd,'--session',session]+(['--operation',operation] if operation else [])+extra)
try:
 session=run(['session','create','--budget-limit','100'])['session']['id']
 if config['mode']=='console':
  console=subprocess.run(common+['--providers',providers,'--http-profiles',profiles,'console','--session',session,'--request',request_file],input=b'Investigate fixture\nAccepted followup remains pending\n',env=env,capture_output=True,timeout=15)
  assert console.returncode==0,(console.returncode,console.stderr.decode(),console.stdout.decode())
  assert not errors,errors
  assert console.stderr.count(b'queued input ')==2,console.stderr
  assert b'Terminal structured review completed; accepted follow-ups remain pending' in console.stderr,console.stderr
  assert len(models)==2 and targets==['/target/fixture'],(len(models),targets)
  with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:
   rows=db.execute('SELECT id,run_command_id,resolved_request,cancelled FROM agent_inputs ORDER BY sequence').fetchall()
   assert len(rows)==2 and rows[0][2] is not None and rows[1][2] is None and rows[1][3]==0,rows
   roots=db.execute("SELECT id,status,outcome FROM operations WHERE json_extract(payload,'$.kind')='scoped_web_agent'").fetchall()
   assert len(roots)==1 and roots[0][1]=='succeeded',roots
   assert json.loads(roots[0][2])['web_review']['review']['hypotheses'][0]['state']=='unverified'
   assert db.execute('SELECT count(*) FROM operations WHERE command_id=?',(rows[1][1],)).fetchone()[0]==0
   assert db.execute("SELECT count(*) FROM operations WHERE json_extract(payload,'$.kind')='agent_http'").fetchone()[0]==1
  queued=run(['queue','list','--session',session])['inputs']
  assert len(queued)==2 and queued[0]['status']=='succeeded' and queued[1]['status']=='pending' and queued[1]['resolved_request'] is None,queued
  assert len(models)==2 and len(targets)==1
  raise SystemExit(0)
 agent_args=['agent','--session',session,'--command-id','web-root','--request',request_file]
 reply=run(agent_args,True);operation=reply['operation'];result=reply['result'];review=result['web_review'];op=operation['id'];hypothesis=review['review']['hypotheses'][0]['id'];obs=review['review']['evidence'][0]
 assert operation['payload']['kind']=='scoped_web_agent' and 'execution' not in operation['payload']['request']
 assert result['status']=='completed' and review['review']['hypotheses'][0]['state']=='unverified'
 assert len(models)==2 and targets==['/target/fixture']
 assert web('runs')['page']['runs'][0]['operation_id']==op
 assert web('show',op)['run']['review']['hypotheses'][0]['id']==hypothesis
 assert len(web('observations',op)['page']['operations'])==1
 assert web('findings',op)['findings'][0]['status']=='new'
 web('evidence',obs['operation_id'])
 body=web('range',obs['operation_id'],['--expected-manifest',obs['response_manifest_sha256'],'--limit','7'])['range']
 assert base64.b64decode(body['data_base64'])==b'fixture'
 web('accept',op,['--hypothesis',hypothesis,'--command-id','triage','--expected-revision','0','--note','Inspect fixture'])
 finding=web('finding',op,['--hypothesis',hypothesis])['finding'];assert finding['revision']==1 and finding['status']=='accepted' and finding['hypothesis']['state']=='unverified'
 plan={'schema_version':1,'oracle_version':'zero-web-exact-response-v1','web_operation_id':op,'web_review_sha256':review['artifacts']['web.review'],'hypothesis_id':hypothesis,'state_mode':'same_static_identity_existing_target','repeats':2,'cases':[{'name':'attack','role':'attack','request':{'url':'/target/attack'},'expected':{'status':200,'body_sha256':digest(b'attack')}},{'name':'control','role':'legitimate_control','request':{'url':'/target/control'},'expected':{'status':200,'body_sha256':digest(b'control')}}]}
 json.dump(plan,open(plan_file,'w'))
 prepared=web('verify-prepare',extra=['--plan',plan_file])['preparation'];assert prepared['approval_required'] is False and len(targets)==1
 verify_args=['web','verify','--session',session,'--command-id','verify','--plan',plan_file,'--expected-intent',prepared['intent_sha256']]
 verified=run(verify_args,True);assessment=verified['result']['assessment'];verification=verified['operation']['id']
 assert assessment['disposition']=='observed_for_plan' and assessment['vulnerability_reportable'] is False
 assert targets==['/target/fixture','/target/attack','/target/control','/target/attack','/target/control'] and len(models)==2
 retry=run(verify_args);assert retry['duplicate'] is True and retry['operation']['id']==verification
 # Snapshot-free exact retry requires only its captured model route, not target config or files.
 os.unlink(profiles)
 retry=subprocess.run(common+['--providers',providers]+agent_args,env=env,capture_output=True,timeout=15);assert retry.returncode==0,retry.stderr;assert json.loads(retry.stdout)['duplicate'] is True
 os.unlink(providers);env.pop('WEB_FIXTURE_KEY')
 report=web('report',op,['--verification',verification]);assert report['verification_state']=='unverified';assert report['verifications'][0]['outcome']['assessment']['disposition']=='observed_for_plan'
 html=run(['web','report','--session',session,'--operation',op,'--verification',verification,'--format','html'],json_output=False)
 assert '<script>web-fixture</script>' not in html and '&lt;script&gt;' in html
 markdown=run(['web','report','--session',session,'--operation',op,'--verification',verification,'--format','markdown'],json_output=False);assert 'observed' in markdown.lower()
 assert len(models)==2 and len(targets)==5
 with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:
  assert db.execute("SELECT count(*) FROM operations WHERE json_extract(payload,'$.kind')='agent_http'").fetchone()[0]==5
  assert db.execute("SELECT count(*) FROM web_triage_decisions").fetchone()[0]==1
finally:
 for server in servers:server.shutdown();server.server_close()
"##;
