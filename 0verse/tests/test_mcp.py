"""M5 #29 — the MCP bridge tool handlers, driven by a fake transport.

No network, no MCP SDK required: tests drive the transport-free ``Engine`` +
``dispatch`` + the JSON-RPC ``handle_rpc``/``serve_stub`` loop directly, with
``api.scan`` monkeypatched to a deterministic fake so no real engine runs.
"""

from __future__ import annotations

import io
import json

import pytest

from zeroverse import mcp
from zeroverse.api import ScanFinding, ScanResult


def _fake_result(path: str) -> ScanResult:
    f = ScanFinding(
        id="abc123",
        bug_class="CWE-78",
        severity="high",
        file=path,
        function="main",
        offset="0x401000",
        source="getenv",
        sink="system",
        confirmed=True,
        hypothesis=True,
        pruned=False,
        capability="command-exec",
        pov_path="",
        repro_cmd="",
        dedup_bucket="b1",
        explanation="cmd injection",
    )
    return ScanResult(
        contract_version="1.0",
        tool={"name": "0verse", "version": "0.0.1"},
        binary=path,
        format="ELF",
        arch="x86-64",
        backend="rizin",
        triage="ELF x86-64",
        stages_run=["ingest", "analyze", "dynamic"],
        findings=[f],
        note="",
        terminal_state="confirmed",
        status_reason="PoV reproduced",
    )


@pytest.fixture
def engine(monkeypatch) -> mcp.Engine:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(mcp, "scan", lambda path, opts=None: _fake_result(str(path)))
    return mcp.Engine()


def test_tools_list_exposes_typed_capability_tools() -> None:
    names = {t["name"] for t in mcp.TOOLS}
    assert names == {
        "scan_binary",
        "list_findings",
        "get_pov",
        "get_report",
        "triage_binary",
        "preflight_binary",
        "get_capabilities",
        "list_bug_classes",
    }
    for t in mcp.TOOLS:
        assert "inputSchema" in t and t["inputSchema"]["type"] == "object"


def test_dispatch_scan_then_list_then_pov(engine: mcp.Engine) -> None:
    summary = json.loads(mcp.dispatch(engine, "scan_binary", {"path": "/bin/x"}))
    assert summary["findings"] == 1 and summary["confirmed"] == 1
    findings = json.loads(mcp.dispatch(engine, "list_findings", {}))
    assert findings[0]["sink"] == "system"
    pov = json.loads(mcp.dispatch(engine, "get_pov", {"finding_id": "abc123"}))
    assert pov["confirmed"] is True and pov["id"] == "abc123"


def test_get_report_returns_ndjson(engine: mcp.Engine) -> None:
    mcp.dispatch(engine, "scan_binary", {"path": "/bin/x"})
    report = mcp.dispatch(engine, "get_report", {"format": "ndjson"})
    head = json.loads(report.splitlines()[0])
    assert head["_meta"]["contract_version"] == "1.0"


def test_errors_are_tool_errors_not_crashes(engine: mcp.Engine) -> None:
    with pytest.raises(mcp.ToolError):
        engine.list_findings()  # nothing scanned yet
    with pytest.raises(mcp.ToolError):
        mcp.dispatch(engine, "nonexistent", {})
    mcp.dispatch(engine, "scan_binary", {"path": "/bin/x"})
    with pytest.raises(mcp.ToolError):
        engine.get_pov("does-not-exist")


def test_jsonrpc_stub_full_handshake(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    # The fallback stub transport: feed initialize -> tools/list -> tools/call over
    # in-memory stdio and read the JSON-RPC responses back.
    monkeypatch.setattr(mcp, "scan", lambda path, opts=None: _fake_result(str(path)))
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},  # notification: no reply
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "scan_binary", "arguments": {"path": "/bin/x"}},
        },
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "list_findings", "arguments": {}},
        },
    ]
    stdin = io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n")
    stdout = io.StringIO()
    mcp.serve_stub(stdin=stdin, stdout=stdout)

    responses = [json.loads(ln) for ln in stdout.getvalue().splitlines() if ln.strip()]
    by_id = {r.get("id"): r for r in responses}
    # the notification produced no response.
    assert set(by_id) == {1, 2, 3, 4}
    assert by_id[1]["result"]["serverInfo"]["name"] == "0verse"
    assert {t["name"] for t in by_id[2]["result"]["tools"]} == {
        "scan_binary",
        "list_findings",
        "get_pov",
        "get_report",
        "triage_binary",
        "preflight_binary",
        "get_capabilities",
        "list_bug_classes",
    }
    call = by_id[3]["result"]
    assert call["isError"] is False
    assert json.loads(call["content"][0]["text"])["confirmed"] == 1
    findings = json.loads(by_id[4]["result"]["content"][0]["text"])
    assert findings[0]["sink"] == "system"


def test_jsonrpc_stub_tool_error_is_iserror() -> None:
    stdin = io.StringIO(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {"name": "list_findings", "arguments": {}},
            }
        )
        + "\n"
    )
    stdout = io.StringIO()
    mcp.serve_stub(stdin=stdin, stdout=stdout)
    resp = json.loads(stdout.getvalue().strip())
    assert resp["result"]["isError"] is True  # "no scan yet" -> tool error, not a crash


@pytest.mark.parametrize(
    "name,args",
    [
        ("scan_binary", {"path": 42}),
        ("scan_binary", {"path": "/bin/x", "attempt_limit": True}),
        ("scan_binary", {"path": "/bin/x", "wall_clock_seconds": float("inf")}),
        ("scan_binary", {"path": "/bin/x", "backend": "shell"}),
        ("scan_binary", {"path": "/bin/x", "executor": "local"}),
        ("list_findings", {"unexpected": True}),
        ("preflight_binary", {"path": "x", "timeout_seconds": 999}),
    ],
)
def test_dispatch_validates_schema(engine, name, args):  # type: ignore[no-untyped-def]
    with pytest.raises(mcp.ToolError):
        mcp.dispatch(engine, name, args)


def test_scan_options_and_unavailable_stage_are_explicit(monkeypatch):  # type: ignore[no-untyped-def]
    from dataclasses import replace

    seen = []
    monkeypatch.setattr(mcp, "scan", lambda path, opts: seen.append(opts) or _fake_result(path))
    summary = json.loads(
        mcp.dispatch(
            mcp.Engine(),
            "scan_binary",
            {
                "path": "/bin/x",
                "llm": "codex",
                "model": "model-id",
                "profile": "analysis",
                "bug_class": "uaf",
                "attempt_limit": 2,
                "wall_clock_seconds": 12,
            },
        )
    )
    assert summary["llm"] == "codex"
    assert seen[0].llm == "codex" and seen[0].model == "model-id"
    assert seen[0].budget.attempt_limit == 2 and seen[0].budget.wall_clock_seconds == 12
    assert seen[0].bug_class == "uaf"
    monkeypatch.setattr(
        mcp,
        "scan",
        lambda path, opts: replace(
            _fake_result(path), terminal_state="infra-failed", status_reason="backend missing"
        ),
    )
    response = mcp.handle_rpc(
        mcp.Engine(),
        {
            "id": 1,
            "method": "tools/call",
            "params": {"name": "scan_binary", "arguments": {"path": "/bin/x"}},
        },
    )
    assert response["result"]["isError"]
    assert "backend missing" in response["result"]["content"][0]["text"]


def test_workspace_rejects_escape_and_symlinks(engine, monkeypatch, tmp_path):  # type: ignore[no-untyped-def]
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"secret")
    (root / "escape").symlink_to(outside)
    monkeypatch.setenv("ZEROVERSE_WORKSPACE_ROOT", str(root))
    for path in (str(outside), "../outside", "escape"):
        with pytest.raises(mcp.ToolError, match="escapes"):
            mcp.dispatch(engine, "triage_binary", {"path": path})
    with pytest.raises(mcp.ToolError, match="escapes"):
        mcp.dispatch(engine, "scan_binary", {"path": "target", "confirm_binary": "escape"})
    with pytest.raises(mcp.ToolError, match="escapes"):
        mcp.dispatch(engine, "scan_binary", {"path": "target", "output_dir": "../outputs"})
    engine._last = _fake_result(str(root / "target"))
    engine._last.findings[0].pov_path = str(outside)
    with pytest.raises(mcp.ToolError, match="escapes"):
        engine.get_pov("abc123")


def test_capability_catalog_and_bug_classes_are_honest(engine):  # type: ignore[no-untyped-def]
    catalog = json.loads(mcp.dispatch(engine, "get_capabilities", {}))
    commands = {entry["command"]: entry for entry in catalog["cli_commands"]}
    assert commands["triage"]["tool"] == "triage_binary"
    assert commands["scan"]["status"] == "mcp-supported"
    assert commands["hyperv-prove"]["status"] == "cli-only"
    assert "scout capture" in commands
    assert any("llm=mock" in limit for limit in catalog["limits"])
    classes = json.loads(mcp.dispatch(engine, "list_bug_classes", {}))
    assert any(item["id"] == "logic" and not item["confirmable"] for item in classes)


def test_triage_does_not_execute_target(engine, monkeypatch, tmp_path):  # type: ignore[no-untyped-def]
    import struct

    target = tmp_path / "target"
    header = bytearray(64)
    header[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", header, 16, 2, 62, 1)
    target.write_bytes(header)
    monkeypatch.setenv("ZEROVERSE_WORKSPACE_ROOT", str(tmp_path))
    result = json.loads(mcp.dispatch(engine, "triage_binary", {"path": "target"}))
    assert result["fmt"] == "ELF" and result["bits"] == 64


def test_preflight_preserves_typed_plan_without_injecting_executor(monkeypatch, tmp_path):  # type: ignore[no-untyped-def]
    from types import SimpleNamespace

    from zeroverse import ingest, preflight

    target = tmp_path / "target"
    target.write_bytes(b"target")
    monkeypatch.setenv("ZEROVERSE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(ingest, "triage", lambda path: ingest.Triage(str(path), fmt="ELF"))
    calls = []

    def probe(triage, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(kwargs)
        return SimpleNamespace(
            disposition="infra-failed",
            failure_reason="backend unavailable",
            selected_backend="",
            execution_route="none",
            profile=kwargs["profile"],
            named_capabilities=lambda: [
                (
                    "backend",
                    preflight.Capability(
                        status="unavailable",
                        mandatory=True,
                        failure_disposition="infra-failed",
                        detail="backend unavailable",
                    ),
                )
            ],
        )

    monkeypatch.setattr(preflight, "probe_capabilities", probe)
    result = json.loads(
        mcp.dispatch(
            mcp.Engine(),
            "preflight_binary",
            {
                "path": "target",
                "profile": "confirmation",
                "timeout_seconds": 3,
            },
        )
    )
    assert result["disposition"] == "infra-failed"
    assert result["capabilities"]["backend"]["status"] == "unavailable"
    assert calls[0]["execution_backend"] is None
    assert calls[0]["budget"].budget.wall_clock_seconds == 3
