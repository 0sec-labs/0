"""Real standalone scan executable: target authority, claims, one budget and retained partial exits."""
import copy
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
state=os.path.join(root,'state.db');scanfile=os.path.join(root,'scans.json');providerfile=os.path.join(root,'providers.json');httpfile=os.path.join(root,'http.json')
models=[];targets=[];errors=[];held=threading.Event();release=threading.Event()

def tool(name,args,call='call'):
    return {'type':'function_call','call_id':call,'name':name,'arguments':json.dumps(args)}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        try:
            targets.append(self.path)
            assert self.path=='/target/resource',self.path
            assert self.headers.get('Authorization')=='Bearer target-private-token'
            body=b'bounded observed marker'
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except BaseException as e:errors.append(repr(e));raise
    def do_POST(self):
        try:
            assert self.path=='/responses',self.path # Legacy cloud environment must not enable a sink.
            req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            models.append(req);assert 'target-private-token' not in json.dumps(req)
            names=[t['name'] for t in req['tools']]
            assert 'http_request' in names and 'submit_web_hypotheses' in names
            assert all(t not in names for t in ['ask_operator','execute_snapshot','activate'])
            if 'HOLD' in req['instructions']:
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                self.wfile.write(b'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"waiting"}\n\n');self.wfile.flush();held.set();release.wait(15);return
            if 'EMPTY' in req['instructions']:output=[tool('submit_web_hypotheses',{'hypotheses':[]})]
            elif 'PROSE' in req['instructions']:output=[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'I stopped without submitting a review.'}]}]
            else:
                outputs=[x for x in req['input'] if x.get('type')=='function_call_output']
                if not outputs:
                    output=[tool('http_request',{'method':'GET','url':'/target/resource'},'allowed'),tool('http_request',{'method':'GET','url':'/forbidden'},'denied')]
                else:
                    successful=[]
                    for entry in outputs:
                        try:parsed=json.loads(entry['output'])
                        except json.JSONDecodeError:continue # An explicitly refused tool may return bounded plain error text.
                        if isinstance(parsed,dict) and isinstance(parsed.get('observation'),dict):successful.append(parsed)
                    assert len(successful)==1,outputs
                    ref=successful[0]['observation'];body=successful[0]['response']['body_text']
                    output=[tool('submit_web_hypotheses',{'hypotheses':[{'title':'<script>unverified claim</script>','category':'observed_response','explanation':'A retained response, not a security proof','claimed_impact':'Unverified fixture claim','claimed_severity':'high','citations':[{'operation_id':ref['operation_id'],'response_manifest_sha256':ref['response_manifest_sha256'],'part':{'type':'body','offset':0,'length':len(body.encode())}}]}]})]
            event={'type':'response.completed','response':{'id':'scan-'+str(len(models)),'status':'completed','output':output,'usage':{'input_tokens':2,'output_tokens':1}}}
            data=('data: '+json.dumps(event)+'\n\n').encode()
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except BaseException as e:errors.append(repr(e));raise
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
origin='http://127.0.0.1:'+str(server.server_port);target=origin+'/target/'
policy=json.load(open(os.path.join(root,'policy.json')));policy['base_url']=target;policy['allowed_methods']=['GET']
json.dump({'http':{'policy':policy,'auth':{'revision':'target-v1','headers_env':{'authorization':'SCAN_TARGET_KEY'}}}},open(httpfile,'w'))
json.dump({'model':{'url':origin+'/responses','api_key_env':'SCAN_MODEL_KEY','rates':{'input':1000000,'cached_input':0,'output':1000000},'timeout_ms':20000,'max_response_bytes':65536}},open(providerfile,'w'))
base={'schema_version':1,'kind':'scoped_http','provider':'model','model':'fixture','instructions':'NORMAL bounded HTTP investigation','http_profile':'http','budget_limit':100,'currency':'usd','reservation_per_turn':10,'max_turns':4,'max_hypotheses':4,'deadline_ms':20000}
profiles={'normal':base,'empty':dict(base,instructions='EMPTY submit an honest empty review'),'prose':dict(base,instructions='PROSE stop without structured submission'),'budget':dict(base,budget_limit=12),'deadline':dict(base,instructions='HOLD deadline',deadline_ms=150),'cancel':dict(base,instructions='HOLD cancellation')}
json.dump(profiles,open(scanfile,'w'))
env=dict(os.environ,SCAN_MODEL_KEY='model-private-token',SCAN_TARGET_KEY='Bearer target-private-token')
env.update({'0SEC_CLOUD_SINK':origin+'/trap','0SEC_CLOUD_SCAN_ID':'legacy-trap','0SEC_CLOUD_TOKEN':'sink-private-token','0SEC_EMIT_RESULT_LINE':'1','0SEC_REPORT_PATH':os.path.join(root,'legacy-report.json'),'0SEC_TARGET_AUTH_JSON':json.dumps({'type':'bearer','token':'wrong-legacy-auth'}),'0SEC_TARGET_BASE_URL':origin+'/forbidden','0SEC_TARGET_KILL_AFTER_SEC':'0'})
common=[binary,'--state',state];settings=['--scan-profiles',scanfile,'--providers',providerfile,'--http-profiles',httpfile]
def invoke(args,code=0,configured=False,text=False):
    p=subprocess.run(common+(settings if configured else [])+args,env=env,capture_output=True,timeout=25)
    assert p.returncode==code,(args,p.returncode,p.stdout.decode(),p.stderr.decode(),errors)
    assert not errors,errors
    assert b'0SEC_RESULT=' not in p.stdout and b'target-private-token' not in p.stdout+p.stderr
    return p.stdout.decode() if text else json.loads(p.stdout)
def runargs(profile,command):return ['scan','--target',target,'--profile',profile,'--command-id',command,'--format','json']
def show(id):return invoke(['scan','show','--scan',id])['scan']
def report(id,format='json'):return invoke(['scan','report','--scan',id,'--format',format],text=format!='json')
def rows(sql):
    with sqlite3.connect('file:'+state+'?mode=ro',uri=True) as db:return db.execute(sql).fetchall()
try:
    normal=invoke(runargs('normal','normal'),code=1,configured=True);scan=normal['scan'];id=scan['scan']['id'];result=scan['result']
    assert result['outcome']['stop_reason']=='submitted' and result['outcome']['completeness']=='completed_workflow',result
    assert result['outcome']['summary']['claimed_high']==1 and result['outcome']['summary']['verified_vulnerabilities']==0,result
    assert result['outcome']['security_conclusion']=='not_established' and not result['outcome']['vulnerability_reportable']
    assert scan['budget']['charged']==6 and scan['budget']['reserved']==0,scan
    assert scan['http_usage']=={'requests':1,'request_body_bytes':0,'response_charged_bytes':23,'response_reserved_bytes':0},scan
    assert result['outcome']['http_usage']==scan['http_usage']
    assert len(models)==2 and len(targets)==1,(len(models),targets)
    assert rows('SELECT count(*) FROM sessions')==[(1,)] and rows('SELECT count(*) FROM http_accounts')==[(1,)]
    full=report(id)['report'];assert full['kind']=='retained' and len(full['web']['run']['review']['hypotheses'])==1,full
    html=report(id,'html');assert '&lt;script&gt;' in html and '<script>' not in html,html
    md=report(id,'markdown');assert 'Unverified' in md and 'micro-USD' in md,md
    assert not os.path.exists(env['0SEC_REPORT_PATH'])
    empty=invoke(runargs('empty','empty'),configured=True)['scan'];assert empty['result']['outcome']['summary']['submitted_hypotheses']==0
    assert empty['result']['outcome']['completeness']=='completed_workflow'
    prose=invoke(runargs('prose','prose'),code=2,configured=True)['scan'];assert prose['result']['outcome']['stop_reason']=='stopped_without_submission'
    before=len(models)
    budget=invoke(runargs('budget','budget'),code=4,configured=True)['scan'];assert len(models)==before+1
    assert budget['result']['outcome']['stop_reason']=='budget_limit' and budget['budget']['charged']==3,budget
    # Deadline yields retained uncertainty, never a restarted timer or discarded usage hold.
    deadline=invoke(runargs('deadline','deadline'),code=2,configured=True)['scan']
    assert deadline['close_reason']=='deadline' and deadline['budget']['reserved']==10,deadline
    assert deadline['result']['outcome']['close_reason']=='deadline',deadline
    release.set();held.clear();release.clear()
    # Actual process SIGTERM must drain, print a correlated partial result and preserve the hold.
    p=subprocess.Popen(common+settings+runargs('cancel','cancel'),env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert held.wait(10),'provider not admitted'
    page=invoke(['scan','list','--limit','1'])['page'];live=page['scans'][0]
    assert live['budget']['reserved']==10 and live['phase']!='terminal',live
    db_before=open(state,'rb').read();show(live['scan']['id']);assert open(state,'rb').read()==db_before
    p.send_signal(signal.SIGTERM);stdout,stderr=p.communicate(timeout=15)
    assert p.returncode==143,(p.returncode,stdout,stderr)
    cancelled=json.loads(stdout)['scan'];assert cancelled['budget']['reserved']==10 and cancelled['phase']=='terminal',cancelled
    assert cancelled['result']['outcome']['close_reason']=='cancelled',cancelled
    release.set()
    assert rows("SELECT count(*) FROM operations WHERE status='running'")==[(0,)]
    calls=len(models);requests=len(targets)
    os.unlink(scanfile);os.unlink(providerfile);os.unlink(httpfile);env.pop('SCAN_MODEL_KEY');env.pop('SCAN_TARGET_KEY')
    # Explicitly supplied deleted files must be bypassed for an exact retained command.
    again=invoke(runargs('normal','normal'),code=1,configured=True)
    assert again['duplicate'] and again['scan']['result']==result,again
    assert show(id)['result']==result and report(id)['report']==full
    conflict=runargs('normal','normal');conflict[2]=target+'changed'
    p=subprocess.run(common+conflict,env=env,capture_output=True,timeout=10);assert p.returncode==2
    assert len(models)==calls and len(targets)==requests
finally:
    release.set();server.shutdown();server.server_close()
