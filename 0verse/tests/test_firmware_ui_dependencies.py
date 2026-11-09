"""Compatibility coverage for the optional firmware UI security overrides."""

import io
from unittest.mock import Mock

import pytest


def test_pyfx_renders_unicode_with_patched_terminal_dependencies() -> None:
    pyfx = pytest.importorskip("pyfx")
    app = pyfx.PyfxApp({"greeting": "你好", "items": [1, 2]})
    try:
        app._json_browser.refresh_view({"greeting": "你好", "items": [1, 2]})
        canvas = app._view_frame.render((80, 24), focus=True)
        assert canvas.cols() == 80
        assert canvas.rows() == 24
        assert "你好" in b"\n".join(canvas.text).decode("utf-8")
    finally:
        app._thread_pool_executor.shutdown(wait=True)


def test_urwid_rejects_non_ascii_body_with_ascii_charset_and_closes_fd(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    web = pytest.importorskip("urwid.display.web")
    monkeypatch.setenv("REQUEST_METHOD", "POST")
    monkeypatch.setenv("HTTP_X_URWID_ID", "123")
    monkeypatch.delenv("HTTP_X_URWID_METHOD", raising=False)
    monkeypatch.setenv("CONTENT_TYPE", "text/plain; charset=ascii")
    monkeypatch.setattr(web.sys, "stdin", io.StringIO("é"))
    output = io.StringIO()
    monkeypatch.setattr(web.sys, "stdout", output)
    monkeypatch.setattr(web.os, "open", Mock(return_value=42))
    write = Mock()
    close = Mock()
    monkeypatch.setattr(web.os, "write", write)
    monkeypatch.setattr(web.os, "close", close)
    assert web.handle_short_request() is True
    assert "400 Bad Request" in output.getvalue()
    write.assert_not_called()
    close.assert_called_once_with(42)
