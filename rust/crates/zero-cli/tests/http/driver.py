"""Local-only provider and scoped-target evidence; no real credentials or network targets."""
import base64,http.server,json,os,shutil,signal,sqlite3,subprocess,sys,threading,time
sys.dont_write_bytecode=True
from terminal import run_terminal
config=json.load(open(sys.argv[1],encoding="utf-8"));mode=config["mode"]
models=[];targets=[];release=threading.Event()
secret="fixture-target-auth-canary-934598"
class Target(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):self.handle_request()
    def do_GET(self):self.handle_request()
    def handle_request(self):
        body=self.rfile.read(int(self.headers.get("Content-Length","0")))
        targets.append({"method":self.command,"path":self.path,"headers":dict(self.headers),"body":body})
        payload=("observed λ "+secret+" end").encode()
        self.send_response(500 if mode in ("complete","console","tui") else 200)
        self.send_header("Content-Type","text/plain; charset=utf-8")
        self.send_header("Set-Cookie","unknown-new-cookie=must-not-retain")
        self.send_header("X-Reflected",secret)
        self.send_header("Content-Length",str(100 if mode=="unknown" else len(payload)))
        self.end_headers()
        try:
            if mode=="unknown":self.wfile.write(b"partial");self.wfile.flush();release.wait(12)
            else:self.wfile.write(payload);self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):pass
target=http.server.ThreadingHTTPServer(("127.0.0.1",0),Target);target.daemon_threads=True
threading.Thread(target=target.serve_forever,daemon=True).start()
base="http://127.0.0.1:%d/target/"%target.server_port
class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        request=json.loads(self.rfile.read(int(self.headers["Content-Length"])));models.append(request)
        assert secret not in json.dumps(request)
        if len(models)==1:
            assert any(t["name"]=="http_request" for t in request["tools"])
            args={"url":base+("../outside" if mode=="denied" else "echo"),"body":"host bounded body","headers":{"X-Fixture":"visible"}}
            output=[{"type":"function_call","call_id":"http-call","name":"http_request","arguments":json.dumps(args)}]
        else:output=[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"HTTP observation retained; no safety verdict"}]}]
        event={"type":"response.completed","response":{"id":"http-%d"%len(models),"status":"completed","output":output,"usage":{"input_tokens":2,"output_tokens":1}}}
        data=("data: "+json.dumps(event)+"\n\n").encode();self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
model=http.server.ThreadingHTTPServer(("127.0.0.1",0),Model);model.daemon_threads=True
threading.Thread(target=model.serve_forever,daemon=True).start()
providers=os.path.join(config["root"],"providers.json");profiles=os.path.join(config["root"],"http.json")
with open(providers,"w",encoding="utf-8") as f:json.dump({"fixture":{"url":"http://127.0.0.1:%d/responses"%model.server_port,"api_key_env":"MODEL_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":10000,"max_response_bytes":32768}},f)
policy=config["policy"];policy["base_url"]=base
if mode=="unknown":policy["limits"]["timeout_ms"]=200
with open(profiles,"w",encoding="utf-8") as f:json.dump({"target":{"policy":policy,"auth":{"revision":"fixture-revision-1","headers_env":{"authorization":"HTTP_FIXTURE_AUTH"}}}},f)
env=os.environ.copy();env.update(MODEL_FIXTURE_KEY="model-fixture-only",HTTP_FIXTURE_AUTH=secret)
common=[config["binary"],"--state",config["state"],"--providers",providers]
agent=["agent","--session",config["session"],"--command-id","http-root","--request",config["request"]]
def run(args,environment=env):return subprocess.run(args,env=environment,capture_output=True,timeout=15)
def query(sql):
    with sqlite3.connect("file:"+config["state"]+"?mode=ro",uri=True) as db:return db.execute(sql).fetchall()
try:
    interactive=mode in ("console","tui")
    if interactive:
        args=common+["--http-profiles",profiles,mode,"--session",config["session"],"--request",config["request"]]
        if mode=="tui":result=run_terminal(args,env,models,targets,query,config)
        else:result=subprocess.run(args,env=env,input="Observe λ target\n".encode(),capture_output=True,timeout=15)
        roots=query("SELECT id,status FROM operations WHERE json_extract(payload,'$.kind')='offline_snapshot_agent'")
        assert len(roots)==1,roots
        reply={"operation":{"id":roots[0][0],"status":roots[0][1]}}
    else:
        result=run(common+["--http-profiles",profiles]+agent)
        reply=json.loads(result.stdout)
    assert secret.encode() not in result.stdout+result.stderr
    assert result.returncode==(1 if mode=="unknown" else 0),(result.returncode,result.stderr.decode(),reply)
    assert reply["operation"]["status"]==("unknown" if mode=="unknown" else "succeeded"),reply
    assert len(targets)==(0 if mode=="denied" else 1),targets
    if targets:
        seen=targets[0];assert seen["method"]=="POST";assert seen["body"]==b"host bounded body"
        headers={k.lower():v for k,v in seen["headers"].items()};assert headers["authorization"]==secret;assert headers["content-type"]=="application/json"
    assert len(models)==(1 if mode=="unknown" else 2)
    operations=query("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='agent_http'")
    if mode!="denied":
        assert len(operations)==1
        evidence=run([config["binary"],"--state",config["state"],"--http-profiles","/must-not-read","--providers","/must-not-read","http","show","--session",config["session"],"--operation",operations[0][0],"--evidence"])
        assert evidence.returncode==0,evidence.stderr.decode();assert secret.encode() not in evidence.stdout+evidence.stderr
        assert b"unknown-new-cookie=must-not-retain" not in evidence.stdout
        retained=json.loads(evidence.stdout)
        body=base64.b64decode(retained["body"]["data"],validate=True)
        assert retained["body"]["encoding"]=="base64" and retained["body"]["bytes"]==len(body)
        assert secret.encode() not in body and b"unknown-new-cookie=must-not-retain" not in body
        if mode in ("complete","console","tui"):assert "observed λ".encode() in body
    assert open(os.path.join(config["source"],"file"),"rb").read()==b"unchanged\n"
    if not interactive:
        counts=(len(models),len(targets))
        changed=json.load(open(profiles,encoding="utf-8"));changed["target"]["auth"]["revision"]="rotated-credential-version"
        with open(profiles,"w",encoding="utf-8") as f:json.dump(changed,f)
        conflict=run(common+["--http-profiles",profiles]+agent)
        assert conflict.returncode!=0 and (len(models),len(targets))==counts
        shutil.rmtree(config["source"])
        # Cached exact root retry does not need a now-unavailable target credential/profile.
        retry_env=env.copy();retry_env.pop("HTTP_FIXTURE_AUTH")
        retry=run(common+agent,retry_env);cached=json.loads(retry.stdout)
        assert cached["duplicate"] is True and cached["operation"]["id"]==reply["operation"]["id"]
        assert (len(models),len(targets))==counts
    for path in [config["state"],config["state"]+"-wal"]:
        if os.path.exists(path):assert secret.encode() not in open(path,"rb").read()
    print(json.dumps({"models":len(models),"target_requests":len(targets),"status":reply["operation"]["status"]}))
except Exception:
    sys.stderr.write("HTTP fixture result: %r\n"%locals().get("result"));raise
finally:
    release.set();target.shutdown();model.shutdown()
