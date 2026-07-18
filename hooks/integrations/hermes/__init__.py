"""Vibe Halo integration for Hermes Agent. Standard library only."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional
from urllib import request


def _runtime() -> Optional[dict]:
    try:
        value = json.loads((Path.home() / ".vibe-halo" / "runtime.json").read_text(encoding="utf-8"))
        if value.get("app") != "vibe-halo" or not isinstance(value.get("port"), int) or not isinstance(value.get("token"), str):
            return None
        os.kill(int(value.get("ownerPid")), 0)
        return value
    except Exception:
        return None


def _session(kwargs: dict) -> str:
    raw = kwargs.get("session_id") or kwargs.get("sessionId") or kwargs.get("conversation_id") or "default"
    text = str(raw)[:220]
    return text if text.startswith("hermes:") else f"hermes:{text}"


def _post(route: str, body: dict, timeout: float) -> Optional[dict]:
    value = _runtime()
    if not value:
        return None
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        f"http://127.0.0.1:{value['port']}{route}", data=data, method="POST",
        headers={"Content-Type": "application/json", "x-vibe-halo-token": value["token"]},
    )
    try:
        with request.urlopen(req, timeout=timeout) as response:
            if response.headers.get("x-vibe-halo") != "vibe-halo":
                return None
            raw = response.read(65536)
            return json.loads(raw.decode("utf-8")) if raw else None
    except Exception:
        return None


def _event(name: str, kwargs: dict) -> None:
    _post("/event", {
        "agent_id": "hermes", "event": name, "session_id": _session(kwargs),
        "cwd": str(kwargs.get("cwd") or os.getcwd())[:2000], "source_pid": os.getpid(),
    }, 2.0)


def _questions(args: dict) -> list:
    question = str(args.get("question") or "").strip()[:1000]
    choices = args.get("choices") if isinstance(args.get("choices"), list) else []
    if not question:
        return []
    return [{
        "id": "question_1", "question": question,
        "options": [{"id": f"option_{index + 1}", "label": str(choice)[:240]} for index, choice in enumerate(choices[:20])],
        "allowText": True,
    }]


def _pre_tool(**kwargs: Any):
    tool_name = str(kwargs.get("tool_name") or "Unknown")[:160]
    args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
    if tool_name == "clarify":
        questions = _questions(args)
        if not questions:
            return None
        result = _post("/permission", {
            "agent_id": "hermes", "event": "Elicitation", "session_id": _session(kwargs),
            "request_id": str(kwargs.get("tool_call_id") or kwargs.get("request_id") or "clarify")[:240],
            "tool_name": "clarify", "tool_input": {"questions": questions}, "questions": questions,
            "cwd": os.getcwd(), "source_pid": os.getpid(),
        }, 135.0)
        if not result:
            return None
        if result.get("decision") == "deny":
            return {"action": "block", "message": "User cancelled the clarification"}
        if result.get("decision") == "allow" and isinstance(result.get("answers"), dict):
            answer = next((str(value) for value in result["answers"].values() if value), "")
            if answer:
                return {"action": "block", "message": f"User selected: {answer}"}
        return None
    result = _post("/permission", {
        "agent_id": "hermes", "event": "PermissionRequest", "session_id": _session(kwargs),
        "request_id": str(kwargs.get("tool_call_id") or kwargs.get("request_id") or "")[:240],
        "tool_name": tool_name, "tool_input": args, "cwd": os.getcwd(), "source_pid": os.getpid(),
    }, 135.0)
    if result and result.get("decision") == "deny":
        return {"action": "block", "message": str(result.get("message") or "User denied this tool execution")[:500]}
    return None


def register(ctx) -> None:
    ctx.register_hook("on_session_start", lambda **kwargs: _event("UserPromptSubmit", kwargs))
    ctx.register_hook("pre_llm_call", lambda **kwargs: _event("UserPromptSubmit", kwargs))
    ctx.register_hook("post_llm_call", lambda **kwargs: _event("Stop", kwargs))
    ctx.register_hook("on_session_end", lambda **kwargs: _event("Stop", kwargs))
    ctx.register_hook("pre_tool_call", _pre_tool)
