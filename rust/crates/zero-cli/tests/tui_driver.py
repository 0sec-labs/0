"""Real PTY acceptance driver. All model traffic stays on a local fixture server."""
import errno
import fcntl
import http.server
import json
import os
import pty
import select
import signal
import socketserver
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


def timed_out(_signum, _frame):
    raise TimeoutError("PTY driver overall deadline")


signal.signal(signal.SIGALRM, timed_out)
signal.alarm(35)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers["Content-Length"])
        assert size < 1024 * 1024
        requests.append(json.loads(self.rfile.read(size)))
        prefix = 'data: ' + json.dumps({"type": "response.output_text.delta", "output_index": 0,
                                      "content_index": 0, "delta": "stream-visible"}) + '\n\n'
        final = 'data: ' + json.dumps({"type": "response.completed", "response": {
            "id": "pty-fixture", "status": "completed", "output": [{"type": "message", "content": [
                {"type": "output_text", "text": "stream-visible final-answer"}]}],
            "usage": {"input_tokens": 2, "output_tokens": 1}}}) + '\n\n'
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len((prefix + final).encode())))
        self.end_headers()
        try:
            self.wfile.write(prefix.encode())
            self.wfile.flush()
            if release.wait(20):
                self.wfile.write(final.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


server = Server(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with open(config["providers"], "w", encoding="utf-8") as file:
    json.dump({"fixture": {"url": "http://127.0.0.1:%d/responses" % server.server_port,
                          "api_key_env": "TUI_FIXTURE_KEY", "rates": {
                              "input": 1000000, "cached_input": 0, "output": 1000000},
                          "timeout_ms": 15000, "max_response_bytes": 32768}}, file)
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 110, 0, 0))
env = os.environ.copy()
env.update(TERM="xterm-256color", TUI_FIXTURE_KEY="pty-local-fixture-secret")
proc = None
screen = bytearray()
children = []
child_handles = []


def pump(seconds=0.03):
    if select.select([master], [], [], seconds)[0]:
        try:
            screen.extend(os.read(master, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    assert len(screen) < 8 * 1024 * 1024, "unbounded terminal output"


def until(predicate, label, seconds=8):
    end = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < end, "timeout: " + label
        assert proc.poll() is None, "premature exit: " + label
        pump()


def query(sql):
    with sqlite3.connect("file:" + config["state"] + "?mode=ro", uri=True, timeout=1) as db:
        return db.execute(sql).fetchall()


def send(text):
    os.write(master, text.encode())


try:
    proc = subprocess.Popen(config["argv"], stdin=slave, stdout=slave, stderr=slave,
                            env=env, start_new_session=True)
    until(lambda: b"\x1b[?1049h" in screen, "alternate screen")
    until(lambda: not (termios.tcgetattr(slave)[3] & termios.ICANON), "raw mode")
    until(lambda: b"Ready" in screen, "session history and queue ready")
    children_path = "/proc/%d/task/%d/children" % (proc.pid, proc.pid)
    with open(children_path, encoding="ascii") as file:
        children = [int(pid) for pid in file.read().split()]
    assert children, "TUI did not launch its external app-server"
    child_handles = [os.pidfd_open(child) for child in children]
    mode = config["mode"]
    if mode in ("paste", "stream", "cancel", "quit_active"):
        # Bracketed paste containing a newline must remain composer data.
        send("\x1b[200~héllo λ\nsecond line\x1b[201~")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 19, 72, 0, 0))
        os.kill(proc.pid, signal.SIGWINCH)
        for _ in range(20):
            pump()
        assert not requests, "paste or resize dispatched a provider request"
        assert query("SELECT count(*) FROM agent_inputs")[0][0] == 0, "paste auto-enqueued"
        if mode != "paste":
            send("\r")
            until(lambda: len(requests) == 1, "explicit Enter dispatch")
            until(lambda: b"stream-visible" in screen, "live progress before terminal")
            assert query("SELECT count(*) FROM operations WHERE status='running'")[0][0] > 0
            assert query("SELECT count(*) FROM operations WHERE json_extract(outcome,'$.status')='completed'")[0][0] == 0
            if mode == "stream":
                release.set()
                until(lambda: query("SELECT count(*) FROM operations WHERE json_extract(payload,'$.kind')='offline_snapshot_agent' AND status='succeeded'")[0][0] == 1,
                      "durable completed agent")
            elif mode == "cancel":
                send("\x18")  # Ctrl-X cancels, not application quit.
                until(lambda: query("SELECT count(*) FROM operations WHERE status='unknown'")[0][0] >= 1,
                      "durable uncertain cancellation")
    if mode == "pending":
        for _ in range(20):
            pump()
        assert not requests, "persisted pending input auto-dispatched after restart"
        assert query("SELECT count(*) FROM operations")[0][0] == 0
    if mode == "signal":
        os.kill(proc.pid, signal.SIGTERM)
    elif mode == "backend_error":
        # Simulate the private app-server disappearing after the UI owns the TTY.
        for handle in child_handles:
            signal.pidfd_send_signal(handle, signal.SIGTERM)
    else:
        send("\x11")  # Ctrl-Q
    end = time.monotonic() + 10
    while proc.poll() is None:
        assert time.monotonic() < end, "TUI failed to shut down"
        pump()
    for _ in range(4):
        pump(0.01)
    assert termios.tcgetattr(slave) == original, "terminal attributes were not restored"
    assert b"\x1b[?1049l" in screen, "alternate screen not restored"
    assert b"\x1b[?2004l" in screen, "bracketed paste not disabled"
    assert not any(os.path.exists("/proc/%d" % child) for child in children), "app-server left behind"
    assert b"pty-local-fixture-secret" not in screen, "credential exposed on screen"
    print(json.dumps({"requests": requests, "exit_code": proc.returncode,
                      "restored": True, "screen_bytes": len(screen)}))
except Exception:
    # Only synthetic fixture text reaches this diagnostic; never print config/env.
    sys.stderr.write("Terminal tail: " + repr(bytes(screen[-4000:])) + "\n")
    raise
finally:
    signal.alarm(0)
    release.set()
    if proc is not None and proc.poll() is None:
        if not child_handles:
            try:
                with open("/proc/%d/task/%d/children" % (proc.pid, proc.pid), encoding="ascii") as file:
                    for child in file.read().split():
                        try:
                            child_handles.append(os.pidfd_open(int(child)))
                        except ProcessLookupError:
                            pass
            except FileNotFoundError:
                pass
        # The private app-server has its own process group. Stable handles avoid
        # signaling a reused PID and clean it up even when an assertion fails.
        for handle in child_handles:
            try:
                signal.pidfd_send_signal(handle, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=3)
    for handle in child_handles:
        os.close(handle)
    os.close(master)
    os.close(slave)
    server.shutdown()
