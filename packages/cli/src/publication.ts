import type { OutputReader } from "./commands.ts";
import type { VibecloudConfig } from "./config.ts";

export interface StateInstance { index_key?: string, attributes: { output?: { value?: unknown }, input?: { value?: unknown }, id: string, version: string, spec: string, key: string, content_type: string, function?: Array<{ id: string, tag?: string }> } }
export interface PublicationState {
  serial?: number
  lineage?: string
  resources?: Array<{ mode: string, module?: string, type: string, name: string, instances?: StateInstance[] }>
}

export function instances(state: PublicationState, type: string, name: string): StateInstance[] {
  return state.resources?.filter((resource) => resource.mode === "managed" && !resource.module && resource.type === type && resource.name === name)
    .flatMap((resource) => resource.instances ?? []) ?? [];
}

/** The provider does not refresh gateway.spec. Live invokers own publication truth. */
export async function readLivePublication(state: PublicationState, environment: NodeJS.ProcessEnv, read: OutputReader): Promise<PublicationState> {
  const live = structuredClone(state);
  for (const { attributes } of instances(live, "yandex_api_gateway", "gateway")) {
    const result = JSON.parse(await read("yc", ["serverless", "api-gateway", "get-spec", "--id", attributes.id, "--format", "json"], environment));
    const spec = typeof result.openapi_spec === "string" ? JSON.parse(result.openapi_spec) : result;
    if (!spec.openapi || !spec.info || !spec.paths || typeof spec.paths !== "object") throw new Error(`Cannot read live gateway specification for ${attributes.id}`);
    attributes.spec = JSON.stringify(spec);
  }
  return live;
}

export interface ReleaseRecord {
  release_id: string
  previous: string | null
  protected: string[]
}

export function stateValue(state: PublicationState, name: string): unknown {
  const attributes = instances(state, "terraform_data", name)[0]?.attributes;
  return attributes?.output?.value ?? attributes?.input?.value;
}

export function releaseRecord(state: PublicationState): ReleaseRecord | undefined {
  const value = stateValue(state, "release") as ReleaseRecord | undefined;
  if (value && (typeof value.release_id !== "string" || !Array.isArray(value.protected)
    || !value.protected.every((id) => typeof id === "string") || (value.previous !== null && typeof value.previous !== "string"))) {
    throw new Error("Unsupported publication record; refusing to guess release history");
  }
  return value;
}

export function activeReferences(state: PublicationState): string[] {
  const references: string[] = [];
  for (const { attributes } of instances(state, "yandex_api_gateway", "gateway")) {
    const spec = JSON.parse(attributes.spec);
    if (typeof spec.info?.version === "string") references.push(spec.info.version);
    for (const methods of Object.values(spec.paths ?? {}) as Record<string, unknown>[]) {
      for (const operation of Object.values(methods) as { "x-yc-apigateway-integration"?: { tag?: string } }[]) {
        const tag = operation?.["x-yc-apigateway-integration"]?.tag;
        if (tag) references.push(tag);
      }
    }
  }
  for (const name of ["crons", "triggers"]) for (const { attributes } of instances(state, "yandex_function_trigger", name)) {
    if (attributes.function?.[0]?.tag) references.push(attributes.function[0].tag);
  }
  return [...new Set(references)];
}

export function nextRelease(state: PublicationState, releaseId: string): ReleaseRecord {
  const prior = releaseRecord(state);
  const refs = activeReferences(state);
  return { release_id: releaseId, previous: prior?.release_id ?? refs[0] ?? null, protected: refs };
}

/** Terraform retains committed lineage and live references; ordering never comes from timestamps. */
export function retainedAssets(state: PublicationState, config: VibecloudConfig, cleanup = false) {
  const record = releaseRecord(state);
  const keep = new Set([...activeReferences(state), ...(record ? [record.release_id, ...(record.previous ? [record.previous] : []), ...record.protected] : [])]);
  return Object.fromEntries(instances(state, "yandex_storage_object", "assets").flatMap(({ index_key, attributes }) => {
    const asset = index_key?.split("/")[0];
    const release = /^_vibecloud\/releases\/(r-[^/]+)\//.exec(attributes.key)?.[1];
    // Unknown legacy history is preserved until a completed publication establishes lineage.
    if (!asset || !Object.hasOwn(config.assets ?? {}, asset) || (cleanup && record && release && !keep.has(release))) return [];
    return [[index_key!, { asset_key: asset, file: attributes.key, source: null, source_hash: null, content_type: attributes.content_type }]];
  }));
}

export function hasLegacyInvokers(state: PublicationState): boolean {
  for (const { attributes } of instances(state, "yandex_api_gateway", "gateway")) {
    for (const methods of Object.values(JSON.parse(attributes.spec).paths ?? {}) as Record<string, unknown>[]) {
      for (const operation of Object.values(methods) as { "x-yc-apigateway-integration"?: { type?: string, tag?: string } }[]) {
        const integration = operation?.["x-yc-apigateway-integration"];
        if (integration?.type === "cloud_functions" && (!integration.tag || integration.tag === "$latest")) return true;
      }
    }
  }
  return ["crons", "triggers"].some((name) => instances(state, "yandex_function_trigger", name)
    .some(({ attributes }) => attributes.function?.[0] && (!attributes.function[0].tag || attributes.function[0].tag === "$latest")));
}
