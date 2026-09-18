"""Actual console/TUI steering with a held local SSE response; no paid calls."""
import errno
import fcntl
import http.server
import json
import os
import pty
import select
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
release = threading.Event()


def deadline(_signal, _frame):
    raise TimeoutError("steering fixture overall deadline")


signal.signal(signal.SIGALRM, deadline)
signal.alarm(38)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers["Content-Length"])
        assert size < 1024 * 1024
        body = json.loads(self.rfile.read(size))
        requests.append(body)
        turn = len(requests)
        progress = 'data: ' + json.dumps({"type": "response.output_text.delta", "output_index": 0,
                                        "content_index": 0, "delta": "steering-live-%d" % turn}) + '\n\n'
        final = 'data: ' + json.dumps({"type": "response.completed", "response": {
            "id": "steering-%d" % turn, "status": "completed", "output": [{"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "answer-%d" % turn}]}],
            "usage": {"input_tokens": 2, "output_tokens": 1}}}) + '\n\n'
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len((progress + final).encode())))
        self.end_headers()
        try:
            self.wfile.write(progress.encode())
            self.wfile.flush()
            if turn != 1 or release.wait(20):
                self.wfile.write(final.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
providers = os.path.join(config["root"], "providers.json")
with open(providers, "w", encoding="utf-8") as file:
    json.dump({"fixture": {"url": "http://127.0.0.1:%d/responses" % server.server_port,
                          "api_key_env": "STEERING_FIXTURE_KEY", "rates": {
                              "input": 1000000, "cached_input": 0, "output": 1000000},
                          "timeout_ms": 18000, "max_response_bytes": 32768}}, file)
env = os.environ.copy()
env.update(TERM="xterm-256color", STEERING_FIXTURE_KEY="steering-local-secret")
base = [config["binary"], "--state", config["state"], "--providers", providers]
mode = config["mode"]
proc = None
master = slave = None
children = []
handles = []
screen = bytearray()
stdout = bytearray()


def query(sql):
    with sqlite3.connect("file:" + config["state"] + "?mode=ro", uri=True, timeout=1) as db:
        return db.execute(sql).fetchall()


def root():
    rows = query("SELECT id FROM operations WHERE json_extract(payload,'$.kind')='offline_snapshot_agent' ORDER BY rowid")
    return rows[0][0] if rows else None


def pump(seconds=0.02):
    readers = [master] if mode == "tui" else [proc.stderr.fileno(), proc.stdout.fileno()]
    for fd in select.select(readers, [], [], seconds)[0]:
        try:
            data = os.read(fd, 65536)
            (screen if mode == "tui" or fd == proc.stderr.fileno() else stdout).extend(data)
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
    if mode == "tui":
        os.write(master, text.encode())
    else:
        proc.stdin.write(text.encode())
        proc.stdin.flush()


def receipts(operation):
    # Bypass nonexistent provider/harness config while another process owns state.
    before = {p: open(p, "rb").read() for p in [config["state"], config["state"] + "-wal"] if os.path.isfile(p)}
    reply = subprocess.run([config["binary"], "--state", config["state"], "--providers", "/fixture-absent",
                            "--harness-config", "/fixture-absent", "steer", "list", "--session", config["session"],
                            "--operation", operation, "--limit", "1"], env=env, capture_output=True, timeout=4)
    assert reply.returncode == 0, reply.stderr.decode()
    assert all(open(p, "rb").read() == old for p, old in before.items()), "read-only receipt changed database bytes"
    return json.loads(reply.stdout)["messages"]


try:
    args = base + ["tui" if mode == "tui" else "console", "--session", config["session"], "--request", config["profile"]]
    if mode == "tui":
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        until(lambda: b"Ready" in screen and not termios.tcgetattr(slave)[3] & termios.ICANON, "ready terminal")
        with open("/proc/%d/task/%d/children" % (proc.pid, proc.pid), encoding="ascii") as file:
            children = [int(p) for p in file.read().split()]
        handles = [os.pidfd_open(p) for p in children]
        send("first prompt\r")
        until(lambda: b"steering-live-1" in screen, "held model progress")
        note = "Direction λ\nsecond line"
        send("\x1b[200~" + note + "\x1b[201~")
    else:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
        send("first prompt\n")
        until(lambda: b"admitted operation " in screen and len(requests) == 1, "admitted root")
        note = "Direction λ"
    operation = root()
    assert operation
    assert receipts(operation) == []
    if mode == "tui":
        for _ in range(10):
            pump()
        assert receipts(operation) == [], "paste implicitly steered"
        send("\x14")  # Ctrl-T explicitly steers; Enter still means queued follow-up.
        until(lambda: b"Steering saved" in screen, "durable steering acknowledgment")
    else:
        send("/steer " + note + "\n")
        until(lambda: b"steering message " in screen, "durable steering acknowledgment")
    pending = receipts(operation)
    assert len(pending) == 1 and pending[0]["prompt"] == note and pending[0]["status"] == "pending"
    assert pending[0]["inference_operation_id"] is None
    assert len(requests) == 1, "steering started overlapping provider request"
    assert query("SELECT count(*) FROM agent_inputs")[0][0] == 1, "steering became a separate queued turn"
    if mode == "cancel":
        proc.send_signal(signal.SIGTERM)
    else:
        if mode == "console":
            send("//steer literal followup\n")
            proc.stdin.close()  # EOF drains accepted queue + captured steering.
        release.set()
        if mode == "tui":
            until(lambda: query("SELECT status FROM operations WHERE id='" + operation + "'")[0][0] == "succeeded", "completed steered root")
            until(lambda: b"Captured" in screen, "captured display from retained receipt")
            send("\x11")
    end = time.monotonic() + 10
    while proc.poll() is None:
        assert time.monotonic() < end, "shutdown deadline"
        pump()
    for _ in range(5):
        pump(0.01)
    if mode == "cancel":
        assert proc.returncode != 0
        assert len(requests) == 1
    else:
        assert proc.returncode == 0, bytes(screen).decode(errors="replace")
        assert [v["content"] for v in requests[1]["input"] if v.get("role") == "user"] == ["first prompt", note]
        assert "answer-1" in json.dumps(requests[1]["input"])
        assert all(r["instructions"] == "Fixed host authority" for r in requests)
        if mode == "console":
            assert stdout == b"answer-2\nanswer-3\n"
            assert [v["content"] for v in requests[2]["input"] if v.get("role") == "user"] == ["first prompt", note, "/steer literal followup"]
    restored = False
    if mode == "tui":
        assert termios.tcgetattr(slave) == original
        assert b"\x1b[?1049l" in screen and b"\x1b[?2004l" in screen
        assert not any(os.path.exists("/proc/%d" % child) for child in children)
        restored = True
    assert b"steering-local-secret" not in screen + stdout
    print(json.dumps({"operation": operation, "requests": len(requests), "restored": restored}))
except Exception:
    sys.stderr.write("Fixture diagnostics: " + repr(bytes(screen[-5000:])) + "\n")
    raise
finally:
    signal.alarm(0)
    release.set()
    if proc is not None and proc.poll() is None:
        for handle in handles:
            try:
                signal.pidfd_send_signal(handle, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=3)
    for handle in handles:
        os.close(handle)
    for fd in [master, slave]:
        if fd is not None:
            os.close(fd)
    server.shutdown()
