"""Real local managed invocation: source-bound terminal, no uploads, retries and partial holds."""
import copy, hashlib, http.server, json, os, signal, sqlite3, subprocess, sys, threading, time, uuid
binary, root = sys.argv[1:]
state=os.path.join(root,'state.db'); providers=os.path.join(root,'providers.json'); httpfile=os.path.join(root,'http.json')
models=[]; targets=[]; errors=[]; held=threading.Event(); release=threading.Event()
def tool(name,args):return {'type':'function_call','call_id':'call','name':name,'arguments':json.dumps(args)}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        try:
            targets.append(self.path)
            assert self.path=='/target/resource',self.path
            assert self.headers.get('Authorization')=='Bearer target-secret'
            data=b'managed retained observation'
            self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except BaseException as e:errors.append(repr(e));raise
    def do_POST(self):
        try:
            assert self.path=='/responses',self.path
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])));models.append(req)
            assert 'target-secret' not in json.dumps(req)
            if 'HOLD' in req['instructions']:
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                self.wfile.write(b'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"waiting"}\n\n');self.wfile.flush();held.set();release.wait(15);return
            if 'EMPTY' in req['instructions']:output=tool('submit_web_hypotheses',{'hypotheses':[]})
            else:
                outputs=[v for v in req['input'] if v.get('type')=='function_call_output']
                if not outputs:output=tool('http_request',{'method':'GET','url':'/target/resource'})
                else:
                    result=json.loads(outputs[0]['output']);ref=result['observation']
                    output=tool('submit_web_hypotheses',{'hypotheses':[{'title':'Unverified response claim','category':'observation','explanation':'Retained response only','claimed_impact':'Not a security proof','claimed_severity':'high','citations':[{'operation_id':ref['operation_id'],'response_manifest_sha256':ref['response_manifest_sha256'],'part':{'type':'body','offset':0,'length':len(result['response']['body_text'].encode())}}]}]})
            event={'type':'response.completed','response':{'id':'managed-'+str(len(models)),'status':'completed','output':[output],'usage':{'input_tokens':2,'output_tokens':1}}}
            data=('data: '+json.dumps(event)+'\n\n').encode()
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except BaseException as e:errors.append(repr(e));raise
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
origin='http://127.0.0.1:'+str(server.server_port);target=origin+'/target/'
policy=json.load(open(os.path.join(root,'policy.json')));policy['base_url']=target
json.dump({'http':{'policy':policy,'auth':{'revision':'target-v1','headers_env':{'authorization':'MANAGED_TARGET_KEY'}}}},open(httpfile,'w'))
rates={'input':1000000,'cached_input':0,'output':1000000}
json.dump({'model':{'url':origin+'/responses','api_key_env':'MANAGED_MODEL_KEY','rates':rates,'timeout_ms':20000,'max_response_bytes':65536}},open(providers,'w'))
policy['auth']={'revision':'target-v1','origin':origin,'header_names':['authorization']}
base={'contract_version':'0sec-native-http/v1','cloud_scan_id':str(uuid.uuid4()),'organization_id':'Org_AbC0123456789-cloud','dispatch_id':str(uuid.uuid4()),'grant_revision':'grant-v1','expires_at_ms':int(time.time()*1000)+120000,'target':target,'scan_profile_name':'managed','scan_profile':{'schema_version':1,'kind':'scoped_http','provider':'model','model':'fixture','instructions':'NORMAL scoped investigation','http_profile':'http','budget_limit':100,'currency':'usd','reservation_per_turn':10,'max_turns':4,'max_hypotheses':4,'deadline_ms':20000},'http_policy':policy,'providers':{'model':{'endpoint':origin+'/responses','wire_api':'responses','rates':rates}}}
env=dict(os.environ,MANAGED_MODEL_KEY='model-secret',MANAGED_TARGET_KEY='Bearer target-secret')
env.update({'0SEC_CLOUD_SINK':origin+'/trap','0SEC_CLOUD_SCAN_ID':'wrong-ambient-id','0SEC_CLOUD_TOKEN':'cloud-secret','0SEC_EMIT_RESULT_LINE':'1','0SEC_CLOUD_EVENTS':'1','0SEC_REPORT_PATH':os.path.join(root,'ambient-report.json')})
common=[binary,'--state',state];settings=['--providers',providers,'--http-profiles',httpfile]
def save(name,grant):
    path=os.path.join(root,name+'.grant.json')
    with open(path,'w') as f:json.dump(grant,f)
    os.chmod(path,0o600);return path
def args(grant,report,configured=True):return common+(settings if configured else [])+['managed-http','--grant',grant,'--report',report]
def terminal(stdout,path,grant):
    lines=stdout.decode().splitlines();assert len(lines)==1 and lines[0].startswith('0SEC_NATIVE_RESULT='),lines
    marker=json.loads(lines[0].split('=',1)[1]);raw=open(path,'rb').read();value=json.loads(raw)
    assert marker['file_sha256']=='sha256:'+hashlib.sha256(raw).hexdigest(),marker
    assert marker['bytes']==len(raw),marker
    assert marker['organization_id']==grant['organization_id'],marker
    assert value['cloud_scan_id']==grant['cloud_scan_id'] and value['organization_id']==grant['organization_id'] and value['dispatch_id']==grant['dispatch_id']
    assert b'model-secret' not in raw and b'target-secret' not in raw and b'cloud-secret' not in raw
    assert '0SEC_RESULT=' not in stdout.decode() and '0SEC_EVENT_' not in stdout.decode()
    return value

def invoke(grant,path,code=0,configured=True):
    p=subprocess.Popen(args(grant,path,configured),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    # Observe the first complete marker while process still owns stdout: file must already exist.
    line=p.stdout.readline()
    if line:assert os.path.isfile(path),'marker preceded durable terminal file'
    tail,err=p.communicate(timeout=25);out=line+tail
    assert p.returncode==code,(p.returncode,out,err,errors)
    assert not errors,errors
    return out

def variant(instructions,**profile):
    grant=copy.deepcopy(base);grant['cloud_scan_id']=str(uuid.uuid4());grant['dispatch_id']=str(uuid.uuid4());grant['scan_profile'].update(instructions=instructions,**profile);return grant
try:
    grantfile=save('normal',base);report=os.path.join(root,'terminal.json')
    first=terminal(invoke(grantfile,report,1),report,base)
    assert first['outcome']['completeness']=='completed_workflow' and first['outcome']['summary']['claimed_high']==1,first
    assert first['outcome']['summary']['verified_vulnerabilities']==0 and first['outcome']['security_conclusion']=='not_established'
    assert first['budget']['charged']==6 and first['budget']['reserved']==0 and first['http_usage']['requests']==1
    assert len(models)==2 and len(targets)==1
    assert not os.path.exists(env['0SEC_REPORT_PATH'])
    # Changed immutable grants cannot gain another allowance, even without loading credentials.
    changed=copy.deepcopy(base);changed['scan_profile']['budget_limit']=200;changedfile=save('changed',changed)
    p=subprocess.run(args(changedfile,report,False),env=env,capture_output=True,timeout=15)
    assert p.returncode==2 and p.stdout==b'' and json.load(open(report))==first,(p.stdout,p.stderr)
    # Writer failure retains the actual completed investigation, emits no terminal marker, and retries only publication.
    failure=variant('EMPTY report failure');failurefile=save('failure',failure)
    p=subprocess.run(args(failurefile,'/proc/self/0sec-native-managed.json'),env=env,capture_output=True,timeout=25)
    assert p.returncode==2 and p.stdout==b'',(p.returncode,p.stdout,p.stderr)
    before=len(models);repaired=os.path.join(root,'repaired.json')
    fixed=terminal(invoke(failurefile,repaired,0,False),repaired,failure)
    assert fixed['outcome']['completeness']=='completed_workflow' and len(models)==before
    # A deadline is distinct from provider certainty; both remain in the native envelope.
    deadline=variant('HOLD deadline',deadline_ms=150);deadlinefile=save('deadline',deadline);deadlineout=os.path.join(root,'deadline.json')
    partial=terminal(invoke(deadlinefile,deadlineout,2),deadlineout,deadline)
    assert partial['close_reason']=='deadline' and partial['outcome']['stop_reason']=='unknown' and partial['budget']['reserved']==10,partial
    held.clear()
    cancel=variant('HOLD cancellation');cancelfile=save('cancel',cancel);cancelout=os.path.join(root,'cancel.json')
    p=subprocess.Popen(args(cancelfile,cancelout),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert held.wait(10)
    # Repeating a currently owned dispatch must not publish a false terminal or cancel its owner.
    active=subprocess.run(args(cancelfile,os.path.join(root,'active.json'),False),env=env,capture_output=True,timeout=15)
    assert active.returncode==2 and active.stdout==b'' and not os.path.exists(os.path.join(root,'active.json'))
    p.send_signal(signal.SIGTERM);out,err=p.communicate(timeout=25)
    assert p.returncode==143,(out,err)
    cancelled=terminal(out,cancelout,cancel)
    assert cancelled['close_reason']=='cancelled' and cancelled['outcome']['stop_reason']=='unknown' and cancelled['budget']['reserved']==10,cancelled
    with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:
        assert db.execute("SELECT count(*) FROM operations WHERE status IN ('running','admitted')").fetchone()[0]==0
    # Kill an owner during a paid inference, then recover by exact execution retry
    # with no credentials/configuration. Recovery must never replay the request.
    held.clear()
    killed=variant('HOLD owner death');killedfile=save('killed',killed);killedout=os.path.join(root,'killed.json')
    p=subprocess.Popen(args(killedfile,killedout),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert held.wait(10)
    p.kill();out,err=p.communicate(timeout=10)
    assert p.returncode==-signal.SIGKILL and out==b'' and not os.path.exists(killedout),(out,err)
    with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:
        assert db.execute("SELECT count(*) FROM operations WHERE status='running'").fetchone()[0]>0
        count=db.execute('SELECT count(*) FROM sessions').fetchone()[0]
    os.remove(providers);os.remove(httpfile);env.pop('MANAGED_MODEL_KEY');env.pop('MANAGED_TARGET_KEY')
    counts=(len(models),len(targets));offline=os.path.join(root,'offline.json')
    recovered=terminal(invoke(killedfile,killedout,2),killedout,killed)
    assert recovered['controller_status']=='unknown' and recovered['root_status']=='unknown' and recovered['outcome'] is None,recovered
    assert recovered['budget']['reserved']==10 and recovered['publication']['status']=='unavailable' and recovered['native_publication'] is None,recovered
    assert counts==(len(models),len(targets))
    retried=terminal(invoke(grantfile,offline,1),offline,base)
    assert retried==first and counts==(len(models),len(targets))
    with sqlite3.connect(state) as db:
        assert db.execute('SELECT count(*) FROM sessions').fetchone()[0]==count
        assert db.execute("SELECT count(*) FROM operations WHERE status IN ('running','admitted')").fetchone()[0]==0
    # Report corruption does not rewrite validated accounting/outcome or invent a clean publication.
    with sqlite3.connect(state) as db:
        digest=first['native_publication']['report_sha256']
        db.execute('UPDATE artifacts SET bytes=? WHERE digest=?',(b'corrupt retained report',digest))
    unavailable=os.path.join(root,'unavailable.json')
    degraded=terminal(invoke(grantfile,unavailable,2),unavailable,base)
    assert degraded['publication']=={'status':'unavailable','reason':'retained_report_unavailable','report':None},degraded
    assert degraded['outcome']==first['outcome'] and degraded['budget']==first['budget'] and degraded['native_publication']==first['native_publication']
    assert counts==(len(models),len(targets))
    # Corrupting immutable grant metadata still fails closed without any terminal marker.
    with sqlite3.connect(state) as db:
        db.execute('UPDATE artifacts SET bytes=? WHERE digest=?',(b'corrupt scan intent',first['scan']['intent_sha256']))
    invalid=os.path.join(root,'invalid.json')
    p=subprocess.run(args(grantfile,invalid),env=env,capture_output=True,timeout=15)
    assert p.returncode==2 and p.stdout==b'' and not os.path.exists(invalid),(p.stdout,p.stderr)
    assert not errors,errors
finally:
    release.set();server.shutdown();server.server_close()
