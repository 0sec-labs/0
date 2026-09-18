"""Real executable, real model HTTP, owned target fixtures; no paid/external calls."""
import http.server
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time

binary, root = sys.argv[1:]
state = os.path.join(root, "state.db")
providers = os.path.join(root, "providers.json")
plan_file = os.path.join(root, "plan.json")
models = []
errors = []
hold = threading.Event()
arrived = threading.Event()
release = threading.Event()


def tool(name, args):
    return {"type": "function_call", "call_id": name, "name": name, "arguments": json.dumps(args)}


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            models.append(request)
            assert any(t["name"] == "http_request" for t in request["tools"])
            assert not any(t["name"] == "execute_snapshot" for t in request["tools"])
            if hold.is_set():
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"held local fixture"}\n\n')
                self.wfile.flush()
                arrived.set()
                release.wait(15)
                return
            outputs = [v for v in request["input"] if v.get("type") == "function_call_output"]
            if not outputs:
                assert "private-marker-" not in json.dumps(request), request
                output = [tool("http_request", {"url": "/resource", "method": "GET"})]
            else:
                assert len(outputs) == 1, outputs
                observation = json.loads(outputs[0]["output"])["observation"]
                assert observation["completeness"] == "complete", observation
                output = [tool("submit_web_hypotheses", {"hypotheses": []})]
            event = {"type": "response.completed", "response": {"id": "strategy-" + str(len(models)), "status": "completed", "output": output, "usage": {"input_tokens": 2, "output_tokens": 1}}}
            body = ("data: " + json.dumps(event) + "\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            if not hold.is_set():
                raise
        except BaseException as exc:
            errors.append(repr(exc))
            raise


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
json.dump({"fixture": {"url": "http://127.0.0.1:%d/responses" % server.server_port, "api_key_env": "STRATEGY_KEY", "rates": {"input": 1000000, "cached_input": 0, "output": 1000000}, "timeout_ms": 20000, "max_response_bytes": 65536}}, open(providers, "w"))
plan = {
    "schema_version": 1, "renderer_version": "strategy_advisory_v1", "oracle_version": "local_web_marker_v1",
    "baseline": {"schema_version": 1, "advisory_utf8": "Baseline investigation advice"},
    "candidate": {"schema_version": 1, "advisory_utf8": "Candidate investigation advice λ"},
    "host": {"provider": "fixture", "model": "fixture", "instructions": "Inspect the scoped fixture and submit supported claims only", "max_turns": 3, "reservation_per_turn": 10, "max_hypotheses": 2},
    "scenarios": [{"id": lane + ("-positive" if positive else "-negative"), "family": lane + ("-positive" if positive else "-negative"), "lane": lane, "public_task": "Inspect /resource and compare /control if useful", "resource_path": "/resource", "control_path": "/control", "marker": "private-marker-" + lane + str(positive), "positive": positive} for lane in ["development", "final"] for positive in [True, False]],
    "repeats": 2,
    "limits": {"model_micro_usd": 1000, "model_calls": 64, "http_requests": 64, "http_request_body_bytes": 1048576, "http_response_decoded_bytes": 16777216, "experiments": 0, "runs": 16, "max_parallel_runs": 1},
    "expires_at_ms": int(time.time() * 1000) + 3600000,
    "minimum_development_gain": 1, "minimum_final_gain": 1,
}
json.dump(plan, open(plan_file, "w"))
env = dict(os.environ, STRATEGY_KEY="local-strategy-secret")
common = [binary, "--state", state]


def invoke(args, configured=False, text=False, success=True):
    result = subprocess.run(common + (["--providers", providers] if configured else ["--providers", "/unused/providers", "--http-profiles", "/unused/http", "--harness-config", "/unused/harness"]) + args, env=env, capture_output=True, timeout=35)
    assert (result.returncode == 0) == success, (args, result.returncode, result.stdout.decode(), result.stderr.decode(), errors)
    assert not errors, errors
    return result.stdout.decode() if text or not success else json.loads(result.stdout)


def query(sql):
    with sqlite3.connect("file:" + state + "?mode=ro", uri=True) as db:
        return db.execute(sql).fetchall()


def inspect(command, campaign, extra=None, text=False):
    return invoke(["strategy", command, "--campaign", campaign] + (extra or []), text=text)


process = None
try:
    created = invoke(["strategy", "create", "--command-id", "paired", "--plan", plan_file], True)
    campaign = created["campaign"]["campaign"]["id"]
    assert len(models) == 0
    dev = invoke(["strategy", "run", "--campaign", campaign, "--lane", "development"], True)["report"]
    assert dev["qualification"] == "qualification_only" and dev["completed_lanes"] == ["development"], dev
    assert dev["decision"] == "inconclusive" and "protected_final_not_run" in dev["reasons"], dev
    assert len(models) == 16, (len(models), dev)
    assert query("SELECT count(*) FROM campaign_exposures") == [(0,)]
    feedback = inspect("dev-feedback", campaign)["feedback"]
    assert len(feedback["cases"]) == 8 and all(c["lane"] == "development" for c in feedback["cases"])
    rows, cursor = [], 0
    while True:
        page = inspect("runs", campaign, ["--after-sequence", str(cursor), "--limit", "3"])["page"]
        rows.extend(page["runs"])
        if page["next_after_sequence"] is None:
            break
        assert page["next_after_sequence"] > cursor
        cursor = page["next_after_sequence"]
    assert len(rows) == 8 and len({r["id"] for r in rows}) == 8
    final = invoke(["strategy", "run", "--campaign", campaign, "--lane", "final"], True)["report"]
    assert final["completed_lanes"] == ["development", "final"] and final["decision"] == "not_improved", final
    assert len(models) == 32, (len(models), final)
    assert query("SELECT count(*) FROM campaign_exposures") == [(1,)]
    before = query("SELECT count(*) FROM operations")
    retry = invoke(["strategy", "run", "--campaign", campaign, "--lane", "final"], True)["report"]
    assert retry["report_sha256"] == final["report_sha256"] and len(models) == 32
    assert query("SELECT count(*) FROM operations") == before
    assert inspect("dev-feedback", campaign)["feedback"] == feedback
    status = inspect("status", campaign)["snapshot"]
    assert status["usage"]["model_calls"] == 32 and status["usage"]["http_requests"] == 16, status
    assert status["usage"]["model_charged_micro_usd"] == 96 and status["usage"]["model_reserved_micro_usd"] == 0
    for command in ["status", "runs", "report", "dev-feedback"]:
        rendered = inspect(command, campaign, ["--format", "text"], text=True)
        assert "qualification_only" in rendered and "private-marker-" not in rendered
    # A distinct frozen plan shares no protected commitment with the completed campaign.
    plan["candidate"]["advisory_utf8"] = "Cancellation candidate"
    json.dump(plan, open(plan_file, "w"))
    cancelled = invoke(["strategy", "create", "--command-id", "cancel", "--plan", plan_file], True)["campaign"]["campaign"]["id"]
    hold.set()
    process = subprocess.Popen(common + ["--providers", providers, "strategy", "run", "--campaign", cancelled, "--lane", "development"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert arrived.wait(8), "provider was not reached"
    live = inspect("status", cancelled)["snapshot"]
    assert live["usage"]["model_reserved_micro_usd"] == 10 and live["usage"]["active_runs"] == 1, live
    count = len(models)
    process.send_signal(signal.SIGINT)
    stdout, stderr = process.communicate(timeout=12)
    assert process.returncode == 1, (process.returncode, stdout.decode(), stderr.decode())
    stopped = inspect("status", cancelled)["snapshot"]
    assert stopped["campaign"]["status"] == "cancelled", stopped
    assert stopped["usage"]["model_reserved_micro_usd"] == 10 and stopped["usage"]["active_runs"] == 0, stopped
    assert len(models) == count
    release.set()
    server.shutdown()
    server.server_close()
    os.unlink(providers)
    env.pop("STRATEGY_KEY")
    report = inspect("report", cancelled)["report"]
    assert report["decision"] == "inconclusive", report
    assert inspect("report", campaign)["report"]["report_sha256"] == final["report_sha256"]
    offline = subprocess.run(common + ["strategy", "run", "--campaign", campaign, "--lane", "final"], env=env, capture_output=True, timeout=12)
    assert offline.returncode == 0, (offline.stdout.decode(), offline.stderr.decode())
    assert json.loads(offline.stdout)["report"]["report_sha256"] == final["report_sha256"]
    assert len(models) == count
finally:
    release.set()
    if process is not None and process.poll() is None:
        process.kill()
        process.wait(timeout=5)
    server.shutdown()
    server.server_close()
