import { normalizeApplication } from "./application-model.ts";
import { functionGroups, type FunctionDeclaration, type FunctionRoute } from "./function-groups.ts";

export interface DeploymentDeclaration extends FunctionDeclaration {
  assets?: Record<string, unknown>
  databases?: Record<string, unknown>
  ai?: Partial<Record<"responses" | "realtime" | "speechkit_stt" | "speechkit_tts" | "image_generation", boolean>>
}

/** One policy compiler supplies builders, Terraform and local capability discovery. */
export function compileDeploymentPlan(declaration: DeploymentDeclaration) {
  declaration = normalizeApplication(declaration);
  const groups = functionGroups(declaration);
  const functions = declaration.functions ?? {};
  const routes = declaration.gateway.routes ?? [];
  const keys = Object.fromEntries(Object.entries(groups).flatMap(([key, group]) => Object.keys(group.functions).map((name) => [name, key])));
  const capabilities = new Set(Object.values(functions).flatMap((definition) => definition.features?.ai ?? []));
  const http = routes.filter((route) => route.function && (route.method ?? "ANY").toUpperCase() !== "WS");
  const sharedHttp = new Set(http.map((route) => keys[route.function!])).size === 1
    && !Object.keys(declaration.assets ?? {}).length
    && http.every((route) => /^(nodejs|python|golang)/.test(functions[route.function!].runtime ?? "nodejs22"));
  const gatewayRoutes: FunctionRoute[] = sharedHttp
    ? [...routes.filter((route) => (route.method ?? "ANY").toUpperCase() === "WS"), ...["/", "/*"].map((pattern) => ({ pattern, function: http[0].function }))]
    : routes;
  return {
    schema_version: 2,
    local: {
      cloud_only: Object.entries(groups).filter(([, group]) => group.kind !== "http" || !group.runtime.startsWith("nodejs"))
        .flatMap(([, group]) => Object.keys(group.functions)),
    },
    function_groups: Object.fromEntries(Object.entries(groups).map(([key, { functions, ...group }]) => [key, { ...group, members: Object.keys(functions) }])),
    function_group_keys: keys,
    gateway_routes: gatewayRoutes.map((route) => ({ pattern: route.pattern, method: (route.method ?? "ANY").toUpperCase(), function: route.function ?? null, assets: route.assets ?? null })),
    timer_payloads: Object.fromEntries(Object.entries(functions).filter(([, definition]) => definition.cron).map(([name, definition]) => [name,
      /^(nodejs|python|golang)/.test(definition.runtime ?? "nodejs22") || Object.keys(groups[keys[name]].functions).length > 1 ? name : definition.cron!.payload ?? null])),
    databases: Object.keys(declaration.databases ?? {}).sort(),
    ai: {
      responses: declaration.ai?.responses === true || capabilities.has("responses"),
      realtime: declaration.ai?.realtime === true || capabilities.has("realtime"),
      speechkit_stt: declaration.ai?.speechkit_stt === true || capabilities.has("speechkit_stt"),
      speechkit_tts: declaration.ai?.speechkit_tts === true || capabilities.has("speechkit_tts"),
      image_generation: declaration.ai?.image_generation === true || capabilities.has("image_generation"),
    },
  };
}
export type DeploymentPlan = ReturnType<typeof compileDeploymentPlan>;

/** Vite matches the request URL, including a query string. */
export function functionProxyPatterns(routes: FunctionRoute[]): string[] {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...new Set(routes.filter((route) => route.function && (route.method ?? "ANY").toUpperCase() !== "WS")
    .map((route) => route.pattern.endsWith("*") ? `^${escape(route.pattern.slice(0, -1))}` : `^${escape(route.pattern)}(?:\\?|$)`))];
}
