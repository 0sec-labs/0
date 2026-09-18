"""Physical CLI search: proposal tools, measured Development, one account, retained cancellation."""
import copy
import hashlib
import http.server
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time

binary,root=sys.argv[1:]
state=os.path.join(root,'state.db');registry=os.path.join(root,'registry.db')
providers=os.path.join(root,'providers.json');host_file=os.path.join(root,'host.json')
plan_file=os.path.join(root,'search.json');baseline_file=os.path.join(root,'baseline.json')
models=[];errors=[];attempts={};arrived=threading.Event();release=threading.Event()

def digest(value):return 'sha256:'+hashlib.sha256(value).hexdigest()
def tool(name,args):return {'type':'function_call','call_id':name,'name':name,'arguments':json.dumps(args)}

class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        try:
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            models.append(request)
            names=[t['name'] for t in request['tools']]
            if request['model']=='proposal-model':
                assert names==['submit_strategy_proposal'],names
                assert 'private-search-marker-' not in json.dumps(request),request
                encoded=json.dumps(request)
                mode=next(v for v in ['NORMAL','BUDGET','CANCEL'] if 'CLI_SEARCH_'+v in encoded)
                if mode=='CANCEL':
                    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                    self.wfile.write(b'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"held proposer"}\n\n');self.wfile.flush()
                    arrived.set();release.wait(20);return
                n=attempts.get(mode,0);attempts[mode]=n+1
                if n<2:
                    args={'action':'propose','advisory':{'schema_version':1,'advisory_utf8':'CANDIDATE_'+('ONE: stop honestly' if n==0 else 'TWO: inspect the resource and cite supported observations λ')},'rationale':'Proposal rationale, not measured evidence'}
                else:args={'action':'stop','reason':'No further useful advisory change'}
                output=[tool('submit_strategy_proposal',args)]
            else:
                assert request['model']=='evaluation-model'
                assert 'http_request' in names and 'submit_web_hypotheses' in names
                assert all(name not in names for name in ['submit_strategy_proposal','execute_snapshot','activate'])
                if 'CANDIDATE_TWO' not in request['instructions']:
                    output=[tool('submit_web_hypotheses',{'hypotheses':[]})]
                else:
                    results=[v for v in request['input'] if v.get('type')=='function_call_output']
                    if not results:
                        assert 'private-search-marker-' not in json.dumps(request)
                        output=[tool('http_request',{'url':'/resource','method':'GET'})]
                    else:
                        assert len(results)==1
                        response=json.loads(results[0]['output']);body=response['response']['body_text'];ref=response['observation']
                        assert ref['completeness']=='complete'
                        claims=[]
                        if 'private-search-marker-' in body:
                            claims=[{'title':'Observed fixture disclosure','category':'fixture_disclosure','explanation':'Actual resource evidence','claimed_impact':'Development fixture only','claimed_severity':'low','citations':[{'operation_id':ref['operation_id'],'response_manifest_sha256':ref['response_manifest_sha256'],'part':{'type':'body','offset':0,'length':len(body.encode())}}]}]
                        output=[tool('submit_web_hypotheses',{'hypotheses':claims})]
            event={'type':'response.completed','response':{'id':'search-'+str(len(models)),'status':'completed','output':output,'usage':{'input_tokens':2,'output_tokens':1}}}
            data=('data: '+json.dumps(event)+'\n\n').encode()
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):
            if not arrived.is_set():raise
        except BaseException as exc:errors.append(repr(exc));raise

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model);server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
endpoint='http://127.0.0.1:%d/responses'%server.server_port
rates={'input':1000000,'cached_input':0,'output':1000000}
profiles={name:{'url':endpoint,'api_key_env':'SEARCH_LOCAL_KEY','rates':rates,'timeout_ms':20000,'max_response_bytes':65536} for name in ['evaluation','proposer']}
json.dump(profiles,open(providers,'w'))
policy=json.load(open(os.path.join(root,'http-policy.json')));policy['base_url']='http://127.0.0.1:%d/target/'%server.server_port
baseline={'schema_version':1,'advisory_utf8':'BASELINE: stop after an honest empty review'}
json.dump(baseline,open(baseline_file,'w'))
limits={'model_micro_usd':1000,'model_calls':128,'http_requests':64,'http_request_body_bytes':1048576,'http_response_decoded_bytes':16777216,'experiments':0,'runs':32,'max_parallel_runs':1}
engine_bytes=b'local search engine fixture descriptor';open(os.path.join(root,'engine.bin'),'wb').write(engine_bytes)
authority={'schema_version':1,'host':{'provider':'evaluation','model':'evaluation-model','instructions':'Investigate only within the supplied host authority','max_turns':3,'reservation_per_turn':10,'max_hypotheses':2},'provider_context':{name:{'endpoint':endpoint,'wire_api':'responses','rates':rates} for name in profiles},'http_profile_name':'runtime','http_policy':policy,'campaign_limits':limits,'accepted_suite_sha256':['sha256:'+'c'*64],'minimum_development_gain':1,'minimum_final_gain':1,'canary_required':False}
host={'registry':registry,'engine_artifact':digest(engine_bytes),'plugins':{},'strategy':authority,'bootstrap':{'state_schema':'search-fixture-v1','compatible_state_schemas':[],'initial_state':{'history_counter':9},'artifacts':{digest(engine_bytes):'engine.bin'},'plugin_components':{}}}
json.dump(host,open(host_file,'w'))
plan={'schema_version':1,'objective':'CLI_SEARCH_NORMAL improve useful supported investigation','proposer':{'provider':'proposer','model':'proposal-model','instructions':'Propose bounded advisory guidance or stop','reservation_micro_usd':10,'max_output_tokens':2048},'scenarios':[{'id':'development-'+str(p),'family':'development-'+str(p),'lane':'development','public_task':'Inspect /resource and compare /control if useful','resource_path':'/resource','control_path':'/control','marker':'private-search-marker-'+str(p),'positive':p} for p in [True,False]],'repeats':2,'max_proposals':4,'max_candidates':3,'limits':limits,'expires_at_ms':int(time.time()*1000)+3600000,'minimum_development_gain':1}
json.dump(plan,open(plan_file,'w'))
env=dict(os.environ,SEARCH_LOCAL_KEY='local-search-secret')
common=[binary,'--state',state]
settings=['--providers',providers,'--strategy-host',host_file]

def invoke(args,configured=False,success=True,text=False):
    result=subprocess.run(common+(settings if configured else [])+args,env=env,capture_output=True,timeout=35)
    assert (result.returncode==0)==success,(args,result.returncode,result.stdout.decode(),result.stderr.decode(),errors)
    assert not errors,errors
    return result.stdout.decode() if text or not success else json.loads(result.stdout)
def search(command,campaign,*extra):return ['strategy','search',command,'--campaign',campaign]+list(extra)
def query(sql,args=()):
    with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:return db.execute(sql,args).fetchall()
def create(command,changed=None):
    json.dump(changed or plan,open(plan_file,'w'))
    return invoke(['strategy','search','create','--command-id',command,'--plan',plan_file],True)['snapshot']['campaign']['campaign']['id']

try:
    installed=invoke(['strategy','registry','bootstrap','--host',host_file,'--baseline',baseline_file,'--command-id','baseline','--reason','Trusted local search fixture'])
    initial=invoke(['strategy','registry','status','--registry',registry])['current']
    assert len(models)==0
    for field in ['final','canary','auto_promote']:
        invalid=copy.deepcopy(plan);invalid[field]=True;json.dump(invalid,open(plan_file,'w'))
        result=invoke(['strategy','search','create','--command-id','unsupported','--plan',plan_file],True,success=False)
        assert 'private-search-marker-' not in result
        assert len(models)==0
    campaign=create('normal')
    assert len(models)==0
    report=invoke(search('run',campaign),True)['report']
    assert report['qualification']=='development_only' and len(report['evaluations'])==2,report
    assert report['evaluations'][0]['improved'] is False and report['evaluations'][1]['improved'] is True,report
    assert len(report['proposals'])==3 and report['proposals'][-1]['output']['action']=='stop',report
    assert len(models)==23,(len(models),report)
    status=invoke(search('status',campaign))['snapshot']
    assert status['proposal_attempts']==3 and status['candidates']==2 and status['active_proposals']==0,status
    usage=status['campaign']['usage']
    assert usage['model_charged_micro_usd']==69 and usage['model_reserved_micro_usd']==0,usage
    assert usage['model_calls']==23 and usage['http_requests']==4,usage
    first=invoke(search('candidates',campaign,'--limit','1'))['page'];assert len(first['candidates'])==1 and first['next_after_sequence'] is not None,first
    second=invoke(search('candidates',campaign,'--after-sequence',str(first['next_after_sequence']),'--limit','1'))['page']
    assert len(second['candidates'])==1 and second['candidates'][0]['id']!=first['candidates'][0]['id'],second
    detail=invoke(search('candidate',campaign,'--candidate',second['candidates'][0]['id']))['candidate']
    assert detail['improved'] is True and all(v['lane']=='development' for v in detail['cases'])
    text=invoke(search('report',campaign,'--format','text'),text=True)
    assert '69 charged, 0 held' in text and 'no protected Final' in text and 'Model rationale (untrusted)' in text,text
    assert query('SELECT count(*) FROM campaigns')==[(1,)]
    assert query('SELECT count(*) FROM campaign_runs WHERE campaign_id=?',(campaign,))==[(16,)]
    assert query('SELECT count(*) FROM campaign_exposures')==[(0,)]
    invoke(['strategy','eligibility','prepare','--registry',registry,'--campaign',campaign],success=False)
    # Proposal charges reduce the same account available for the very first evaluation.
    tight=copy.deepcopy(plan);tight['objective']='CLI_SEARCH_BUDGET shared admission';tight['limits']['model_micro_usd']=15
    constrained=create('budget',tight);before=len(models)
    limited=invoke(search('run',constrained),True)['report']
    assert 1<=len(models)-before<=2,(len(models)-before,limited)
    snapshot=invoke(search('status',constrained))['snapshot']
    assert snapshot['campaign']['usage']['model_charged_micro_usd']==3*(len(models)-before),snapshot
    retained_count=len(models)
    invoke(search('run',constrained),True)
    assert len(models)==retained_count
    # A held proposer supports concurrent readonly snapshots and joined cancellation.
    cancelplan=copy.deepcopy(plan);cancelplan['objective']='CLI_SEARCH_CANCEL retained uncertain reservation'
    cancelled=create('cancel',cancelplan)
    proc=subprocess.Popen(common+settings+search('run',cancelled),env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert arrived.wait(10),'proposer never admitted'
    live=invoke(search('status',cancelled))['snapshot']
    assert live['active_proposals']==1 and live['campaign']['usage']['model_reserved_micro_usd']==10,live
    proc.send_signal(signal.SIGINT)
    stdout,stderr=proc.communicate(timeout=15)
    assert proc.returncode!=0,(stdout,stderr)
    partial=json.loads(stdout);assert partial['type']=='strategy_search_report',partial
    release.set()
    terminal=invoke(search('status',cancelled))['snapshot']
    assert terminal['active_proposals']==0 and terminal['campaign']['usage']['model_reserved_micro_usd']==10,terminal
    count=len(models)
    server.shutdown();server.server_close()
    os.unlink(providers);os.unlink(host_file);env.pop('SEARCH_LOCAL_KEY')
    json.dump(plan,open(plan_file,'w'))
    retried_create=invoke(['strategy','search','create','--command-id','normal','--plan',plan_file])
    assert retried_create['duplicate'] is True and retried_create['snapshot']['campaign']['campaign']['id']==campaign,retried_create
    assert invoke(search('run',campaign))['report']==report
    invoke(search('report',campaign));invoke(search('report',cancelled));invoke(search('run',cancelled))
    assert len(models)==count
    assert query("SELECT count(*) FROM operations WHERE status='running'")==[(0,)]
    assert invoke(['strategy','registry','status','--registry',registry])['current']==initial
    with sqlite3.connect(registry) as db:
        assert db.execute('SELECT count(*) FROM activations').fetchone()==(1,)
finally:
    release.set();server.shutdown();server.server_close()
