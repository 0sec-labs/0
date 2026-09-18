"""Local HTTP and real PTY question flow. Explicit answers confer no authority."""
import errno, fcntl, http.server, json, os, pty, re, select, signal, sqlite3, struct, subprocess, sys, termios, threading, time
config=json.load(open(sys.argv[1],encoding="utf-8"))
mode=config["mode"]
requests=[]
release=threading.Event()
proc=None
master=slave=None
handles=[]
children=[]
screen=bytearray()
stdout=bytearray()
def deadline(_signal,_frame): raise TimeoutError("question fixture deadline")
signal.signal(signal.SIGALRM,deadline)
signal.alarm(38)
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        size=int(self.headers["Content-Length"])
        assert size<1024*1024
        request=json.loads(self.rfile.read(size));requests.append(request);turn=len(requests)
        if turn==1:
            if mode=="eof_before": assert release.wait(15)
            ask={"questions":[{"header":"Priority","question":"Choose a fixture", "options":[{"label":"First","recommended":True},{"label":"Second"}]},{"header":"Details","question":"Additional information?","allow_custom":True}]}
            output=[{"type":"function_call","call_id":"question-call","name":"ask_operator","arguments":json.dumps(ask)}]
        else:
            output=[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Answer received; unchanged authority"}]}]
        event={"type":"response.completed","response":{"id":"questions-%d"%turn,"status":"completed","output":output,"usage":{"input_tokens":2,"output_tokens":1}}}
        body=("data: "+json.dumps(event)+"\n\n").encode()
        self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Content-Length",str(len(body)));self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError): pass
server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler);server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
providers=os.path.join(config["root"],"providers.json")
with open(providers,"w",encoding="utf-8") as f:
    json.dump({"fixture":{"url":"http://127.0.0.1:%d/responses"%server.server_port,"api_key_env":"QUESTION_FIXTURE_KEY","rates":{"input":1000000,"cached_input":0,"output":1000000},"timeout_ms":18000,"max_response_bytes":32768}},f)
env=os.environ.copy();env.update(TERM="xterm-256color",QUESTION_FIXTURE_KEY="local-question-secret")
base=[config["binary"],"--state",config["state"],"--providers",providers]
def query(sql):
    with sqlite3.connect("file:"+config["state"]+"?mode=ro",uri=True,timeout=1) as db:return db.execute(sql).fetchall()
def questions():
    reply=subprocess.run([config["binary"],"--state",config["state"],"--providers","/not-used","--harness-config","/not-used","questions","list","--session",config["session"]],env=env,capture_output=True,timeout=4)
    assert reply.returncode==0,reply.stderr.decode()
    return json.loads(reply.stdout)["questions"]

def pump(seconds=0.02):
    readers = [master] if mode.startswith("tui") else [proc.stderr.fileno(), proc.stdout.fileno()]
    for fd in select.select(readers, [], [], seconds)[0]:
        try:
            data = os.read(fd, 65536)
            (screen if mode.startswith("tui") or fd == proc.stderr.fileno() else stdout).extend(data)
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
    if mode.startswith("tui"):
        os.write(master, text.encode())
    else:
        proc.stdin.write(text.encode())
        proc.stdin.flush()


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
    args=base+["tui" if mode.startswith("tui") else "console","--session",config["session"],"--request",config["profile"]]
    if mode.startswith("tui"):
        master,slave=pty.openpty();original=termios.tcgetattr(slave)
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack("HHHH",38,140,0,0))
        proc=subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
        until(lambda:"Ready" in terminal_text(),"terminal ready")
        with open("/proc/%d/task/%d/children"%(proc.pid,proc.pid),encoding="ascii") as f:children=[int(p) for p in f.read().split()]
        handles=[os.pidfd_open(p) for p in children]
        send("first prompt\r")
        until(lambda:"1 loaded pending questions" in terminal_text(),"question notification without stealing focus")
        send("\x1b[200~saved conversation draft\x1b[201~")
        send("\x0f")
        until(lambda:"Question inbox" in terminal_text(),"questions inbox")
        send("\r")
        until(lambda:"Choose a fixture" in terminal_text(),"question detail")
    else:
        proc=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,start_new_session=True)
        send("first prompt\n")
        if mode=="eof_before":
            until(lambda:len(requests)==1,"held provider request")
            proc.stdin.close();release.set()
        else:until(lambda:b"operator question " in screen,"question display")
    if mode!="eof_before":
        rows=questions();assert len(rows)==1 and rows[0]["status"]=="pending";question=rows[0]["operation_id"]
        assert len(requests)==1
        assert query("SELECT count(*) FROM agent_inputs")[0][0]==1
        if mode.startswith("tui"):
            send(" \x1b[B\x1b[B")
            send("\x1b[200~Unicode λ\ninformation only\x1b[201~")
            send("\r")
            for _ in range(10):pump()
            assert questions()[0]["status"]=="pending","paste/Enter submitted"
            send("\x1b")
            until(lambda:"saved conversation draft" in terminal_text(),"underlying composer preserved")
            send("\x0f")
            until(lambda:"information only" in terminal_text() and "Operator questions" in terminal_text(),"retained question draft")
            if mode=="tui_cancel":send("\x18")
            else:send("\x13")
        elif mode=="eof_after":proc.stdin.close()
        elif mode=="dismiss":send("/dismiss "+question+"\n");proc.stdin.close()
        else:
            bad={"type":"answer","answers":[{"question_index":0,"selected_indices":[99]},{"question_index":1,"custom_text":"not sent"}]}
            send("/answer "+question+" "+json.dumps(bad)+"\n")
            until(lambda:b"Answer not sent:" in screen,"invalid answer rejected")
            assert questions()[0]["status"]=="pending" and len(requests)==1
            valid={"type":"answer","answers":[{"question_index":0,"selected_indices":[0]},{"question_index":1,"custom_text":"Unicode λ\ninformation only\n"}]}
            send("/answer "+question+" "+json.dumps(valid,ensure_ascii=False)+"\n");proc.stdin.close()
    if mode.startswith("tui"):
        expected="cancelled" if mode=="tui_cancel" else "answered"
        until(lambda:questions()[0]["status"]==expected,"retained question decision")
        if mode=="tui":
            until(lambda:"Decision saved" in terminal_text(),"durable answer acknowledgment")
            assert "No permissions granted" in terminal_text()
        send("\x11")
    end=time.monotonic()+12
    while proc.poll() is None:
        assert time.monotonic()<end,"console/terminal remained blocked"
        pump()
    for _ in range(5):pump(0.01)
    rows=questions();assert len(rows)==1
    cancelled=mode.startswith("eof") or mode=="tui_cancel"
    assert len(requests)==(1 if cancelled else 2)
    if not cancelled:
        assert requests[0]["tools"]==requests[1]["tools"]
        assert requests[1]["instructions"]=="Fixed question authority"
        assert "question-call" in json.dumps(requests[1]["input"])
        assert ("dismiss" if mode=="dismiss" else "Unicode") in json.dumps(requests[1]["input"])
        if mode!="dismiss":
            answers=rows[0]["decision"]["decision"]["answers"]
            assert answers[0]["selected_indices"]==[0]
            assert answers[1]["custom_text"]=="Unicode λ\ninformation only\n"
    if mode in ("eof_before","eof_after","console"):assert proc.returncode!=0
    elif mode!="tui_cancel":assert proc.returncode==0
    restored=False
    if mode.startswith("tui"):
        assert termios.tcgetattr(slave)==original
        assert b"\x1b[?1049l" in screen and b"\x1b[?2004l" in screen
        assert not any(os.path.exists("/proc/%d"%p) for p in children)
        restored=True
    assert b"local-question-secret" not in screen+stdout
    print(json.dumps({"restored":restored,"requests":len(requests)}))
except Exception:
    sys.stderr.write("Question fixture diagnostics: "+(terminal_text() if mode.startswith("tui") else bytes(screen[-3000:]).decode(errors="replace"))+"\n")
    raise
finally:
    signal.alarm(0);release.set()
    if proc is not None and proc.poll() is None:
        for handle in handles:
            try:signal.pidfd_send_signal(handle,signal.SIGKILL)
            except ProcessLookupError:pass
        os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
    for handle in handles:os.close(handle)
    for fd in [master,slave]:
        if fd is not None:os.close(fd)
    server.shutdown()
