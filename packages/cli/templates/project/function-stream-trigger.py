from typing import Any


def {{HANDLER}}(event: dict[str, Any], context: Any) -> None:
    message_count = len(event.get("messages", []))
    request_id = getattr(context, "request_id", "unknown")
    raise NotImplementedError(
        f"Data Streams handler is not implemented ({message_count} messages, request {request_id})"
    )
