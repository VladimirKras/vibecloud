import json
from typing import Any


def {{HANDLER}}(event: dict[str, Any], context: Any) -> dict[str, Any]:
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps(
            {
                "ok": True,
                "method": event.get("httpMethod"),
                "path": event.get("path"),
                "requestId": getattr(context, "request_id", None),
            }
        ),
    }
