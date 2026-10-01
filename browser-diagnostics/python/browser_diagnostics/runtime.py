from __future__ import annotations

import time
from typing import Any, Callable, Mapping, Optional, Protocol, TypeVar

from .schema import make_event

T = TypeVar("T")


class EventSink(Protocol):
    def write(self, event: Mapping[str, Any]) -> None:
        ...


def _emit_safely(sink: EventSink, fields: Mapping[str, Any]) -> bool:
    try:
        sink.write(make_event(**dict(fields)))
        return True
    except BaseException:
        return False


def _action_fields(
    context: Mapping[str, Any],
    *,
    status: str,
    duration_ms: Optional[float],
    error_code: Optional[str],
) -> Mapping[str, Any]:
    return {
        "component": context.get("component"),
        "event_type": context.get("event_type", "action_state"),
        "task_id": context.get("task_id"),
        "request_id": context.get("request_id"),
        "connection_id": context.get("connection_id"),
        "generation": context.get("generation"),
        "status": status,
        "duration_ms": duration_ms,
        "error_code": error_code,
    }


def observe_action(
    action: Callable[[], T],
    sink: EventSink,
    context: Mapping[str, Any],
    *,
    classify_error: Callable[[BaseException], str] = lambda error: "UNCLASSIFIED_ERROR",
) -> T:
    """Run an action while making diagnostics strictly best-effort and non-interfering."""

    started = time.monotonic()
    _emit_safely(sink, _action_fields(context, status="running", duration_ms=None, error_code=None))
    try:
        result = action()
    except BaseException as error:
        error_code = "UNCLASSIFIED_ERROR"
        try:
            candidate = classify_error(error)
            make_event(
                **_action_fields(
                    context,
                    status="failed",
                    duration_ms=0.0,
                    error_code=candidate,
                )
            )
            error_code = candidate
        except BaseException:
            error_code = "UNCLASSIFIED_ERROR"
        elapsed = max(0.0, (time.monotonic() - started) * 1000.0)
        _emit_safely(
            sink,
            _action_fields(context, status="failed", duration_ms=elapsed, error_code=error_code),
        )
        raise
    elapsed = max(0.0, (time.monotonic() - started) * 1000.0)
    _emit_safely(sink, _action_fields(context, status="succeeded", duration_ms=elapsed, error_code=None))
    return result
