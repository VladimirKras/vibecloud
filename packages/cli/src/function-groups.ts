import { normalizeFunction, type FunctionKind, type FunctionDefinition, type FunctionRoute, type FunctionDeclaration } from "./application-model.ts";
export type { FunctionKind, FunctionDefinition, FunctionRoute, FunctionDeclaration } from "./application-model.ts";

export function functionKind(name: string, definition: FunctionDefinition, routes: FunctionRoute[]): FunctionKind {
  return normalizeFunction(name, definition, routes).kind;
}

export function functionGroupKey(name: string, definition: FunctionDefinition, routes: FunctionRoute[]): string {
  const kind = functionKind(name, definition, routes);
  // Data Streams supplies no source identity. Keep its consumers isolated.
  return kind === "stream" ? `stream-${name}` : `${kind}-${definition.runtime ?? "nodejs22"}`;
}

export function functionGroups(declaration: FunctionDeclaration) {
  const groups: Record<string, {
    kind: FunctionKind
    runtime: string
    handler: string
    functions: Record<string, FunctionDefinition>
    memory_mb: number
    timeout_seconds: number
  }> = {};
  for (const [name, source] of Object.entries(declaration.functions ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const routes = declaration.gateway.routes ?? [];
    const definition = normalizeFunction(name, source, routes);
    const key = functionGroupKey(name, definition, routes);
    const runtime = definition.runtime ?? "nodejs22";
    const kind = functionKind(name, definition, routes);
    const native = /^(nodejs|python|golang)/.test(runtime);
    const group = groups[key] ??= {
      kind, runtime, functions: {}, memory_mb: 0, timeout_seconds: 0,
      handler: kind === "stream" || !native ? definition.handler : runtime.startsWith("golang") ? "router.Handler" : "router.handler",
    };
    group.functions[name] = definition;
    group.memory_mb = Math.max(group.memory_mb, definition.memory_mb);
    group.timeout_seconds = Math.max(group.timeout_seconds, definition.timeout_seconds);
    if (!native && Object.keys(group.functions).length > 1) {
      const first = Object.values(group.functions)[0];
      if (definition.handler !== first.handler || JSON.stringify(definition.build) !== JSON.stringify(first.build)) {
        throw new Error(`function group ${key} requires one shared custom build command and entrypoint; its builder receives VIBECLOUD_FUNCTION_MANIFEST`);
      }
    }
  }
  return groups;
}

/** Compile precedence once: exact paths, longest prefixes, then explicit methods. */
export function orderFunctionRoutes<T extends FunctionRoute>(routes: T[]): T[] {
  return routes.toSorted((left, right) => Number(!right.pattern.endsWith("*")) - Number(!left.pattern.endsWith("*"))
    || right.pattern.length - left.pattern.length
    || Number((right.method ?? "ANY").toUpperCase() !== "ANY") - Number((left.method ?? "ANY").toUpperCase() !== "ANY"));
}

/** Routes are already in precedence order, so all runtimes take the first match. */
export function matchFunctionRoute<T extends FunctionRoute>(routes: T[], method: string, pathname: string): T | undefined {
  return routes.find((route) => {
    if (!route.function) return false;
    const declared = (route.method ?? "ANY").toUpperCase();
    if (method === "WS" ? declared !== "WS" : declared === "WS" || (declared !== "ANY" && declared !== method.toUpperCase())) return false;
    return route.pattern.endsWith("*") ? pathname.startsWith(route.pattern.slice(0, -1)) : pathname === route.pattern;
  });
}
