"""Generated deployment router. Authored handlers stay in separate packages."""
import asyncio
import importlib
import inspect
import json
from pathlib import Path

_config = json.loads(Path(__file__).with_suffix(".json").read_text())
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)


async def _invoke(name, event, context):
    target = _config["handlers"][name]
    result = getattr(importlib.import_module(target["module"]), target["exported"])(event, context)
    return await result if inspect.isawaitable(result) else result


def handler(event, context):
    return _loop.run_until_complete(_dispatch(event, context))


async def _dispatch(event, context):
    if _config["kind"] != "timer":
        method = "WS" if _config["kind"] == "websocket" else event.get("httpMethod", "").upper()
        path = event.get("path", "")
        # Routes arrive from the build in precedence order, with normalized methods.
        for route in _config["routes"]:
            if route["method"] != method and (route["method"] != "ANY" or method == "WS"):
                continue
            pattern = route["pattern"]
            wildcard = pattern.endswith("*")
            prefix = pattern[:-1] if wildcard else pattern
            if not (path.startswith(prefix) if wildcard else path == prefix):
                continue
            routed = {**event, "resource": prefix + "{path+}" if wildcard else prefix,
                      "pathParameters": {"path": path[len(prefix):]} if wildcard else None}
            return await _invoke(route["function"], routed, context)
        return {"statusCode": 404, "body": "Not found"}
    messages = event.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("Expected a timer message batch")
    batches = {}
    for message in messages:
        name = message.get("details", {}).get("payload")
        if message.get("event_metadata", {}).get("event_type") != "yandex.cloud.events.serverless.triggers.TimerMessage" or name not in _config["timers"]:
            raise ValueError("Unknown timer dispatch target")
        details = {**message["details"]}
        details.pop("payload", None)
        details.update(_config["timers"][name])
        batches.setdefault(name, []).append({**message, "details": details})
    result = None
    for name, batch in batches.items():
        result = await _invoke(name, {**event, "messages": batch}, context)
    return result
