import { matchFunctionRoute, type FunctionRoute } from "./function-groups.ts";

interface RoutedEvent {
  path?: string
  httpMethod?: string
  messages?: Array<{ event_metadata?: { event_type?: string }, details?: { payload?: string } }>
  [key: string]: unknown
}

interface RouterContext { logicalFunctionName?: string }
type Handler = (event: RoutedEvent, context: RouterContext) => unknown;

export function createFunctionRouter(
  kind: "http" | "websocket" | "timer",
  routes: FunctionRoute[],
  handlers: Record<string, () => Promise<Handler>>,
  timers: Record<string, { payload?: string }>,
) {
  async function invoke(name: string, event: RoutedEvent, context: RouterContext) {
    if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown ${kind} handler: ${name}`);
    const handler = await handlers[name]();
    const logicalContext = Object.create(context) as RouterContext;
    logicalContext.logicalFunctionName = name;
    return handler(event, logicalContext);
  }
  return async (event: RoutedEvent, context: RouterContext) => {
    if (kind !== "timer") {
      const route = matchFunctionRoute(routes, kind === "websocket" ? "WS" : event.httpMethod ?? "", event.path ?? "");
      if (!route?.function) return { statusCode: 404, body: "Not found" };
      return invoke(route.function, {
        ...event,
        resource: route.pattern.endsWith("*") ? `${route.pattern.slice(0, -1)}{path+}` : route.pattern,
        pathParameters: route.pattern.endsWith("*") ? { path: event.path!.slice(route.pattern.length - 1) } : null,
      }, context);
    }
    if (!Array.isArray(event.messages) || event.messages.length === 0) throw new Error("Expected a timer message batch");
    const batches = new Map<string, NonNullable<RoutedEvent["messages"]>>();
    for (const message of event.messages) {
      const name = message.details?.payload;
      if (message.event_metadata?.event_type !== "yandex.cloud.events.serverless.triggers.TimerMessage"
        || !name || !Object.hasOwn(timers, name) || !Object.hasOwn(handlers, name)) throw new Error("Unknown timer dispatch target");
      const details = { ...message.details };
      if (timers[name].payload === undefined) delete details.payload;
      else details.payload = timers[name].payload;
      const batch = batches.get(name) ?? [];
      batch.push({ ...message, details });
      batches.set(name, batch);
    }
    let result: unknown;
    for (const [name, messages] of batches) result = await invoke(name, { ...event, messages }, context);
    return result;
  };
}
