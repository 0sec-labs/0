"""Real advisory session + paired evaluation + source-verified import, entirely local."""
import hashlib
import http.server
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time

cfg=json.load(open(sys.argv[1],encoding='utf8'))
root,binary=cfg['root'],cfg['binary']
state=os.path.join(root,'state.db');registry=os.path.join(root,'registry.db')
host_file=os.path.join(root,'host.json');providers=os.path.join(root,'providers.json');http_file=os.path.join(root,'http.json')
plan_file=os.path.join(root,'plan.json');baseline_file=os.path.join(root,'baseline.json');candidate_file=os.path.join(root,'candidate.json')
models=[];errors=[]

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(value):return 'sha256:'+hashlib.sha256(value).hexdigest()
def tool(name,args):return {'type':'function_call','call_id':name,'name':name,'arguments':json.dumps(args)}

class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        try:
            request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            models.append(request)
            assert not any(t['name'] in ('execute_snapshot','inspect','activate','import_strategy_eligibility') for t in request['tools'])
            if any(v.get('content')=='RUNTIME_PROBE' for v in request['input']):
                assert 'BASELINE_ADVICE' in request['instructions'] and 'CANDIDATE_ADVICE' not in request['instructions']
                output=[tool('submit_web_hypotheses',{'hypotheses':[]})]
            elif 'BASELINE_ADVICE' in request['instructions']:
                output=[tool('submit_web_hypotheses',{'hypotheses':[]})]
            else:
                assert 'CANDIDATE_ADVICE' in request['instructions']
                results=[v for v in request['input'] if v.get('type')=='function_call_output']
                if not results:
                    assert 'private-marker-' not in json.dumps(request)
                    output=[tool('http_request',{'url':'/resource','method':'GET'})]
                else:
                    assert len(results)==1
                    observed=json.loads(results[0]['output']);body=observed['response']['body_text'];ref=observed['observation']
                    assert ref['completeness']=='complete'
                    claims=[]
                    if 'private-marker-' in body:
                        claims=[{'title':'Observed fixture disclosure','category':'fixture_disclosure','explanation':'Actual retained resource response','claimed_impact':'Fixture-specific measurement only','claimed_severity':'low','citations':[{'operation_id':ref['operation_id'],'response_manifest_sha256':ref['response_manifest_sha256'],'part':{'type':'body','offset':0,'length':len(body.encode())}}]}]
                    output=[tool('submit_web_hypotheses',{'hypotheses':claims})]
            event={'type':'response.completed','response':{'id':'registry-'+str(len(models)),'status':'completed','output':output,'usage':{'input_tokens':2,'output_tokens':1}}}
            data=('data: '+json.dumps(event)+'\n\n').encode()
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except BaseException as exc:
            errors.append(repr(exc));raise

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model);server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
endpoint='http://127.0.0.1:%d/responses'%server.server_port
rates={'input':1000000,'cached_input':0,'output':1000000}
json.dump({'fixture':{'url':endpoint,'api_key_env':'REGISTRY_FIXTURE_KEY','rates':rates,'timeout_ms':10000,'max_response_bytes':65536}},open(providers,'w'))
policy=cfg['http_policy'];policy['base_url']='http://127.0.0.1:%d/target/'%server.server_port
json.dump({'runtime':{'policy':policy}},open(http_file,'w'))
base={'schema_version':1,'advisory_utf8':'BASELINE_ADVICE: stop after an honest empty review'}
candidate={'schema_version':1,'advisory_utf8':'CANDIDATE_ADVICE: inspect the resource and cite supported observations'}
json.dump(base,open(baseline_file,'w'));json.dump(candidate,open(candidate_file,'w'))
authority_host={'provider':'fixture','model':'fixture','instructions':'Investigate only within the supplied host authority','max_turns':3,'reservation_per_turn':10,'max_hypotheses':2}
limits={'model_micro_usd':1000,'model_calls':64,'http_requests':64,'http_request_body_bytes':1048576,'http_response_decoded_bytes':16777216,'experiments':0,'runs':16,'max_parallel_runs':1}
scenarios=[{'id':lane+('-positive' if positive else '-negative'),'family':lane+('-positive' if positive else '-negative'),'lane':lane,'public_task':'Inspect /resource and compare /control if useful','resource_path':'/resource','control_path':'/control','marker':'private-marker-'+lane+str(positive),'positive':positive} for lane in ['development','final'] for positive in [True,False]]
plan={'schema_version':1,'renderer_version':'strategy_advisory_v1','oracle_version':'local_web_marker_v1','baseline':base,'candidate':candidate,'host':authority_host,'scenarios':scenarios,'repeats':2,'limits':limits,'expires_at_ms':int(time.time()*1000)+3600000,'minimum_development_gain':1,'minimum_final_gain':1}
json.dump(plan,open(plan_file,'w'))
suite=digest(canonical({'version':'local_web_marker_v1','scenarios':sorted([s for s in scenarios if s['lane']=='final'],key=lambda s:s['id'])}))
engine_bytes=b'explicit fixture engine descriptor, not a running binary attestation'
open(os.path.join(root,'engine.bin'),'wb').write(engine_bytes)
host={'registry':registry,'engine_artifact':digest(engine_bytes),'plugins':{'inspector':{'enabled':True,'trusted':False,'grants':['compute']}},'strategy':{'schema_version':1,'host':authority_host,'provider_context':{'fixture':{'endpoint':endpoint,'wire_api':'responses','rates':rates}},'http_profile_name':'runtime','http_policy':policy,'campaign_limits':limits,'accepted_suite_sha256':[suite],'minimum_development_gain':1,'minimum_final_gain':1,'canary_required':False},'bootstrap':{'state_schema':'fixture-state-v1','compatible_state_schemas':[],'initial_state':{'history_counter':7},'artifacts':{digest(engine_bytes):'engine.bin',cfg['worker_sha256']:'worker.bin',cfg['plugin_sha256']:'plugin.json'},'plugin_components':{'plugin:inspector':cfg['plugin_sha256']}}}
json.dump(host,open(host_file,'w'))
env=dict(os.environ,REGISTRY_FIXTURE_KEY='local-registry-secret')
common=[binary,'--state',state]

def invoke(args,configured=False,success=True):
    settings=['--providers',providers,'--http-profiles',http_file,'--strategy-host',host_file] if configured else []
    result=subprocess.run(common+settings+args,env=env,capture_output=True,timeout=35)
    assert (result.returncode==0)==success,(args,result.returncode,result.stdout.decode(),result.stderr.decode(),errors)
    assert not errors,errors
    return json.loads(result.stdout) if success else result

def registry_read():return invoke(['strategy','registry','status','--registry',registry])
def dbrows(path,sql,args=()):
    with sqlite3.connect('file:'+path+'?mode=ro',uri=True) as db:return db.execute(sql,args).fetchall()

try:
    bootstrap=['strategy','registry','bootstrap','--host',host_file,'--baseline',baseline_file,'--command-id','baseline-install','--reason','Explicit local unmeasured fixture baseline']
    # Strict host fields fail before creating a registry and never echo private values.
    for extra in [host,host['strategy'],host['bootstrap'],host['plugins']['inspector']]:
        extra['unsupported_authority']='PRIVATE_CONFIGURATION_SENTINEL'
        json.dump(host,open(host_file,'w'))
        invalid=invoke(bootstrap,success=False)
        assert b'PRIVATE_CONFIGURATION_SENTINEL' not in invalid.stdout+invalid.stderr
        assert not os.path.exists(registry) and len(models)==0
        del extra['unsupported_authority']
    json.dump(host,open(host_file,'w'))
    invalid=bootstrap.copy();invalid[-1]=' '
    invoke(invalid,success=False)
    assert not os.path.exists(registry) and len(models)==0
    installed=invoke(bootstrap)
    assert installed['qualification']=='trusted_unmeasured_baseline' and installed['activation_epoch']==1,installed
    assert len(models)==0
    assert invoke(bootstrap)==installed
    initial=registry_read();baseline=installed['generation']
    assert initial['current']['generation']==baseline and initial['current']['epoch']==1
    session=invoke(['strategy','session','create','--budget-limit','20'],True)['session']['id']
    runtime_args=['strategy','agent','--session',session,'--command-id','runtime','--prompt','RUNTIME_PROBE']
    captured=invoke(runtime_args,True)
    assert captured['result']['status']=='completed' and len(models)==1,captured
    registered=invoke(['strategy','registry','register','--registry',registry,'--baseline-generation',baseline,'--advisory',candidate_file])
    assert registered['candidate_advisory_sha256']==digest(canonical(candidate))
    generation=registered['candidate_generation']
    assert generation!=registered['candidate_advisory_sha256']
    manifests=[json.loads(dbrows(registry,'SELECT json FROM generations WHERE digest=?',(v,))[0][0]) for v in [baseline,generation]]
    assert manifests[0]['components']['plugin:inspector']==manifests[1]['components']['plugin:inspector']==cfg['plugin_sha256']
    before=manifests[0].copy();after=manifests[1].copy();before['components']=dict(before['components']);after['components']=dict(after['components']);before['components'].pop('strategy:advisory');after['components'].pop('strategy:advisory');assert before==after
    create=['strategy','create','--command-id','bound','--plan',plan_file,'--candidate-generation',generation]
    campaign=invoke(create,True)['campaign']['campaign']['id']
    dev=invoke(['strategy','run','--campaign',campaign,'--lane','development'],True)['report']
    assert dev['qualification']=='qualification_only' and dev['completed_lanes']==['development']
    invoke(['strategy','eligibility','prepare','--registry',registry,'--campaign',campaign],success=False)
    final=invoke(['strategy','run','--campaign',campaign,'--lane','final'],True)['report']
    assert final['decision']=='improved_for_fixture_suite' and final['qualification']=='qualification_only',final
    assert len(models)==25,(len(models),final)
    prepared=invoke(['strategy','eligibility','prepare','--registry',registry,'--campaign',campaign])
    expected=prepared['evidence_sha256']
    import_args=['strategy','eligibility','import','--registry',registry,'--campaign',campaign,'--command-id','measured-import','--expected-evidence',expected]
    imported=invoke(import_args);receipt=imported['receipt']
    assert imported['duplicate'] is False and receipt['candidate_generation']==generation,imported
    assert 'measured' in receipt['qualification']
    assert registry_read()['current']==initial['current']
    assert dbrows(registry,'SELECT count(*) FROM strategy_imports')==[(1,)]
    assert dbrows(registry,'SELECT count(*) FROM activations')==[(1,)]
    server.shutdown();server.server_close()
    for path in [providers,http_file,host_file]:os.unlink(path)
    env.pop('REGISTRY_FIXTURE_KEY')
    retried=invoke(runtime_args)
    assert retried['duplicate'] is True and len(models)==25,retried
    for suffix in ['', '-wal','-shm']:
        try:os.unlink(state+suffix)
        except FileNotFoundError:pass
    duplicate=invoke(import_args)
    assert duplicate['duplicate'] is True and duplicate['receipt']==receipt,duplicate
    shown=invoke(['strategy','eligibility','show','--registry',registry,'--receipt',imported['receipt_sha256']])
    assert shown['receipt']==receipt,shown
    bad=import_args.copy();bad[-1]='sha256:'+'0'*64
    invoke(bad,success=False)
    assert dbrows(registry,'SELECT count(*) FROM strategy_imports')==[(1,)]
    assert registry_read()['current']==initial['current'] and len(models)==25
    corrupt=os.path.join(root,'corrupt-registry.db')
    with sqlite3.connect(registry) as src,sqlite3.connect(corrupt) as dst:src.backup(dst)
    with sqlite3.connect(corrupt) as dst:
        dst.execute('UPDATE artifacts SET bytes=? WHERE digest=?',(b'corrupted retained evidence',expected));dst.commit()
    invoke(['strategy','eligibility','show','--registry',corrupt,'--receipt',imported['receipt_sha256']],success=False)
finally:
    server.shutdown();server.server_close()
