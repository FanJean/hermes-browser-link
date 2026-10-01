from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional

SCHEMA_VERSION = "browser.diagnostics/v1"
ALLOWED_EVENT_KEYS = frozenset(
    {
        "schema_version",
        "timestamp",
        "component",
        "event_type",
        "task_id",
        "request_id",
        "connection_id",
        "generation",
        "status",
        "duration_ms",
        "error_code",
        "action",
        "stage",
    }
)
# 中文注释：与扩展共用固定枚举，拒绝内容字段。
_ACTIONS = (None, 'tabs', 'new_tab', 'navigate', 'snapshot', 'click', 'fill', 'press', 'screenshot', 'page.parse', 'semantic_snapshot', 'frame_catalog', 'ref_click', 'ref_fill', 'ref_press', 'ref_set_checked', 'ref_select_option', 'files.upload', 'interaction.capture', 'interaction.bounds', 'interaction.click', 'interaction.drag_coordinates', 'interaction.drag_elements', 'official.ready_state', 'official.goto_url', 'official.new_tab', 'scroll', 'back', 'js.evaluate', 'cdp.send', 'cdp.events', 'network.inspect', 'images', 'console', 'dialog')
_STAGES = (None, 'queue_wait', 'settle_wait', 'overlay', 'target_settle', 'highlight', 'dispatch', 'post_check')
_COMPONENTS = frozenset({"native_bridge", "mv3_background", "mv3_content", "diagnostics"})
_EVENT_TYPES = frozenset(
    {
        "task_state",
        "request_state",
        "connection_state",
        "action_state",
        "buffer_state",
        "sink_state",
    }
)
_STATUSES = frozenset(
    {
        "pending",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
        "connected",
        "disconnected",
        "dropped",
        "rotated",
        "recovered",
    }
)
_OPAQUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_ERROR_CODES = frozenset(
    {
        "UNCLASSIFIED_ERROR",
        "TIMEOUT",
        "CANCELLED",
        "DISCONNECTED",
        "PROTOCOL_ERROR",
        "VALIDATION_ERROR",
        "PERMISSION_DENIED",
        "NOT_FOUND",
        "CONFLICT",
        "RATE_LIMITED",
        "INTERNAL_ERROR",
        "TRANSPORT_ERROR",
    }
)
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class UnsafeDiagnosticField(ValueError):
    """Raised when an event contains data outside the diagnostic allowlist."""


def _utc_timestamp() -> str:
    now = datetime.now(timezone.utc)
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _opaque(name: str, value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not _OPAQUE_RE.fullmatch(value):
        raise UnsafeDiagnosticField(f"{name} must be an opaque identifier")
    return value


def validate_event(event: Mapping[str, Any]) -> Dict[str, Any]:
    if not isinstance(event, Mapping):
        raise UnsafeDiagnosticField("event must be a mapping")
    keys = frozenset(event.keys())
    if keys != ALLOWED_EVENT_KEYS:
        unknown = sorted(str(key) for key in keys - ALLOWED_EVENT_KEYS)
        missing = sorted(ALLOWED_EVENT_KEYS - keys)
        raise UnsafeDiagnosticField(f"event keys rejected; unknown={unknown}, missing={missing}")

    if event["schema_version"] != SCHEMA_VERSION:
        raise UnsafeDiagnosticField("unsupported schema_version")
    timestamp = event["timestamp"]
    if not isinstance(timestamp, str) or not _TIMESTAMP_RE.fullmatch(timestamp):
        raise UnsafeDiagnosticField("timestamp must be canonical UTC milliseconds")
    if event["component"] not in _COMPONENTS:
        raise UnsafeDiagnosticField("component is not allowlisted")
    if event["event_type"] not in _EVENT_TYPES:
        raise UnsafeDiagnosticField("event_type is not allowlisted")
    if event["status"] not in _STATUSES:
        raise UnsafeDiagnosticField("status is not allowlisted")

    duration = event["duration_ms"]
    if duration is not None:
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise UnsafeDiagnosticField("duration_ms must be numeric or null")
        if not math.isfinite(duration) or duration < 0 or duration > 86_400_000:
            raise UnsafeDiagnosticField("duration_ms is outside the allowed range")

    error_code = event["error_code"]
    # 中文注释：协议错误保留具体小写码；固定长度与字符集阻止异常文字进入诊断。
    if error_code is not None and error_code not in _ERROR_CODES and not (isinstance(error_code, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', error_code)):
        raise UnsafeDiagnosticField("error_code is not allowlisted")

    if event["action"] not in _ACTIONS or event["stage"] not in _STAGES:
        raise UnsafeDiagnosticField("action or stage is not allowlisted")
    validated = dict(event)
    for name in ("task_id", "request_id", "connection_id", "generation"):
        validated[name] = _opaque(name, event[name])
    return validated


def make_event(**fields: Any) -> Dict[str, Any]:
    allowed_inputs = ALLOWED_EVENT_KEYS - {"schema_version"}
    unknown = frozenset(fields) - allowed_inputs
    if unknown:
        raise UnsafeDiagnosticField(f"non-allowlisted fields: {sorted(unknown)}")

    event = {
        "schema_version": SCHEMA_VERSION,
        "timestamp": fields.get("timestamp", _utc_timestamp()),
        "component": fields.get("component"),
        "event_type": fields.get("event_type"),
        "task_id": fields.get("task_id"),
        "request_id": fields.get("request_id"),
        "connection_id": fields.get("connection_id"),
        "generation": fields.get("generation"),
        "status": fields.get("status"),
        "duration_ms": fields.get("duration_ms"),
        "error_code": fields.get("error_code"),
        "action": fields.get("action"),
        "stage": fields.get("stage"),
    }
    return validate_event(event)
