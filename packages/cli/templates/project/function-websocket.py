import json
from typing import Any


def {{HANDLER}}(event: dict[str, Any], context: Any) -> dict[str, Any]:
    request_context = event.get("requestContext", {})
    event_type = request_context.get("eventType")
    if event_type != "MESSAGE":
        return {"statusCode": 200, "body": ""}

    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps(
            {
                "ok": True,
                "connectionId": request_context.get("connectionId"),
                "messageId": request_context.get("messageId"),
                "requestId": getattr(context, "request_id", None),
                "body": event.get("body", ""),
            }
        ),
    }
