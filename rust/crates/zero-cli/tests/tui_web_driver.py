"""Real PTY findings acceptance; no provider calls after fixture preparation."""
import errno
import fcntl
import http.server
import json
import os
import pty
import re
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import termios
import threading
import time

config = json.load(open(sys.argv[1], encoding="utf-8"))
requests = []
target_requests = []


def deadline(_signal, _frame):
    raise TimeoutError("findings PTY overall deadline")


signal.signal(signal.SIGALRM, deadline)
signal.alarm(40)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        assert length < 1024 * 1024
        payload = self.rfile.read(length)
        if self.path.startswith("/target"):
            target_requests.append(self.path)
            body = "Retained evidence λ".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        model = json.loads(payload)
        requests.append(model)
        assert not any(t.get("name") == "execute_snapshot" for t in model["tools"])
        if len(requests) == 1:
            call = {"type": "function_call", "call_id": "observe", "name": "http_request", "arguments": json.dumps({"url": "/target/item"})}
        else:
            assert len(requests) == 2
            output = next(json.loads(item["output"]) for item in model["input"] if item.get("type") == "function_call_output")
            observation = output["observation"]
            claim = {"title": "Unverified web claim", "category": "disclosure", "claimed_severity": "medium", "claimed_impact": "Fixture only",
                     "explanation": "Requires independent behavioral verification", "citations": [{"operation_id": observation["operation_id"],
                     "response_manifest_sha256": observation["response_manifest_sha256"], "part": {"type": "body", "offset": 0, "length": 8}}]}
            call = {"type": "function_call", "call_id": "submit", "name": "submit_web_hypotheses", "arguments": json.dumps({"hypotheses": [claim]})}
        event = {"type": "response.completed", "response": {"id": "web-fixture-%d" % len(requests), "status": "completed", "output": [call], "usage": {"input_tokens": 2, "output_tokens": 1}}}
        body = ("data: " + json.dumps(event) + "\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
providers = os.path.join(config["root"], "providers.json")
request = os.path.join(config["root"], "request.json")
with open(providers, "w", encoding="utf-8") as file:
    json.dump({"fixture": {"url": "http://127.0.0.1:%d/responses" % server.server_port,
                          "api_key_env": "FINDINGS_FIXTURE_KEY", "rates": {
                              "input": 1000000, "cached_input": 0, "output": 1000000},
                          "timeout_ms": 3000, "max_response_bytes": 32768}}, file)
http_profiles = os.path.join(config["root"], "http.json")
config["policy"]["base_url"] = "http://127.0.0.1:%d/target/" % server.server_port
with open(http_profiles, "w", encoding="utf-8") as file:
    json.dump({"target": {"policy": config["policy"]}}, file)
with open(request, "w", encoding="utf-8") as file:
    json.dump(config["request"], file)
env = os.environ.copy()
env.update(TERM="xterm-256color", FINDINGS_FIXTURE_KEY="local-findings-secret")
base = [config["binary"], "--state", config["state"]]
seed_base=base+["--providers",providers,"--http-profiles",http_profiles]
seed = subprocess.run(seed_base + ["agent", "--session", config["session"],
                             "--command-id", "seed", "--request", request],
                      env=env, capture_output=True, timeout=10, check=True)
reply = json.loads(seed.stdout)
operation = reply["operation"]["id"]
hypothesis = reply["result"]["web_review"]["review"]["hypotheses"][0]["id"]
assert len(requests) == 2
assert len(target_requests)==1
server.shutdown()
server.server_close()
os.unlink(providers)
os.unlink(http_profiles)


def query(sql):
    with sqlite3.connect("file:" + config["state"] + "?mode=ro", uri=True, timeout=1) as db:
        return db.execute(sql).fetchall()


before_operations = query("SELECT id,status,payload_hash,outcome FROM operations ORDER BY id")
before_artifacts = query("SELECT digest,length(bytes) FROM artifacts ORDER BY digest")
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 140, 0, 0))
screen = bytearray()
proc = None
children = []
handles = []


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
    proc = subprocess.Popen(base + ["tui", "--session", config["session"]],
                            stdin=slave, stdout=slave, stderr=slave, env=env,
                            start_new_session=True)
    # History is a durable readiness anchor; advisory refresh can replace the transient Ready status.
    visible("Observe and submit a hypothesis")
    visible("6 charged / 0 reserved")
    assert not (termios.tcgetattr(slave)[3] & termios.ICANON)
    with open("/proc/%d/task/%d/children" % (proc.pid, proc.pid), encoding="ascii") as file:
        children = [int(pid) for pid in file.read().split()]
    assert children
    handles = [os.pidfd_open(child) for child in children]
    send("\t\t\t")
    visible("Web runs")
    visible(operation)
    send("\r")
    visible("Web run — partial")
    visible("Terminal structured review: retained")
    send("\r")
    visible("Web hypotheses")
    visible("Unverified web claim")
    send("\r")
    visible("Hypothesis detail")
    visible("Unverified")
    assert query("SELECT count(*) FROM web_triage_decisions") == [(0,)]
    send("e")
    visible("Retained HTTP evidence")
    visible("Retained evidence λ")
    visible("Exact range bytes (base64)")
    send("\x1b")
    visible("Retained HTTP observations")
    send("\x1b")
    visible("Web run — partial")
    send("\r")
    visible("Web hypotheses")
    send("\r")
    visible("Hypothesis detail")
    send("a")
    visible("Decision note")
    send("\x1b[200~Operator note λ\na/s/r are inert pasted text\x1b[201~")
    send("\r")  # Enter inserts a newline; only Ctrl-S submits.
    for _ in range(15):
        pump()
    assert query("SELECT count(*) FROM web_triage_decisions") == [(0,)], "paste/Enter submitted a decision"
    assert len(requests) == 2, "browsing/triage called provider"
    send("\x13")
    until(lambda: query("SELECT revision,status FROM web_triage_decisions") == [(1, "accepted")],
          "durable explicit decision")
    visible("Decision saved")
    send("\x11")
    end = time.monotonic() + 10
    while proc.poll() is None:
        assert time.monotonic() < end, "TUI shutdown deadline"
        pump()
    for _ in range(4):
        pump(0.01)
    assert proc.returncode == 0
    assert termios.tcgetattr(slave) == original, "raw terminal attributes not restored"
    assert b"\x1b[?1049h" in screen and b"\x1b[?1049l" in screen
    assert b"\x1b[?2004l" in screen
    assert not any(os.path.exists("/proc/%d" % child) for child in children)
    assert b"local-findings-secret" not in screen
    assert len(requests) == 2
    assert query("SELECT id,status,payload_hash,outcome FROM operations ORDER BY id") == before_operations
    assert query("SELECT digest,length(bytes) FROM artifacts ORDER BY digest") == before_artifacts
    print(json.dumps({"operation": operation, "hypothesis": hypothesis,
                      "requests": len(requests), "target_requests":len(target_requests), "restored": True}))
except Exception:
    sys.stderr.write("Terminal screen: " + terminal_text() + "\n")
    raise
finally:
    signal.alarm(0)
    if proc is not None and proc.poll() is None:
        if not handles:
            try:
                with open("/proc/%d/task/%d/children" % (proc.pid, proc.pid), encoding="ascii") as file:
                    for child in file.read().split():
                        try:
                            handles.append(os.pidfd_open(int(child)))
                        except ProcessLookupError:
                            pass
            except FileNotFoundError:
                pass
        for handle in handles:
            try:
                signal.pidfd_send_signal(handle, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=3)
    for handle in handles:
        os.close(handle)
    os.close(master)
    os.close(slave)
    server.shutdown()
