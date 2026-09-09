import { join } from "node:path";
import type { VibecloudConfig } from "./config.ts";
import { compileDeploymentPlan } from "./deployment-plan.ts";
import { readCommandOutput, type OutputReader } from "./commands.ts";

export interface TerraformMove { from: string, to: string }
const addressPattern = '[a-z_]+\\.[a-z_]+\\["(?:[^"\\\\]|\\\\.)+"\\]';
const blockPattern = new RegExp(`moved\\s*\\{\\s*from\\s*=\\s*(${addressPattern})\\s+to\\s*=\\s*(${addressPattern})\\s*\\}`, "g");
const fromHcl = (address: string) => address.replace(/\$\$\{|%%\{/g, (marker) => marker.slice(1));
const toHcl = (address: string) => address.replace(/\$\{|%\{/g, (marker) => marker[0] + marker);

/** Reconcile against the selected backend and workspace, never a guessed state file. */
export async function reconcileTerraformMoves(infra: string, source: string, added: TerraformMove[], config: VibecloudConfig, readCommand: OutputReader = readCommandOutput, environment = process.env): Promise<string> {
  const local = updateTerraformMoves(source, added, config);
  if (!local.includes("yandex_storage_bucket.assets[")) return local;
  return updateTerraformMoves(local, [], config, await stateAddresses(infra, readCommand, environment));
}

/** Compose and validate retained history without needing credentials or a backend. */
export function updateTerraformMoves(source: string, added: TerraformMove[], config: VibecloudConfig, state: Iterable<string> = []): string {
  const existing = [...source.matchAll(blockPattern)].map(([, from, to]) => ({ from: fromHcl(from), to: fromHcl(to) }));
  const remainder = source.replace(blockPattern, "");
  if (remainder.replace(/#[^\n]*/g, "").trim()) throw new Error("moves.auto.tf contains unsupported authored content; keep custom Terraform blocks in another file");
  if (!existing.length && !added.length) return source;
  let chains = moveChains(existing);
  for (const { from, to } of added) {
    if (from === to) continue;
    const chain = chains.find((entries) => entries.includes(from)) ?? [from];
    if (chain.at(-1) !== from || chains.some((entries) => entries !== chain && entries.includes(to))) {
      throw new Error(`Cannot rename ${from} to ${to}: the address belongs to another retained rename history`);
    }
    if (!chains.includes(chain)) chains.push(chain);
    // A return to an older name rotates the history instead of forming a cycle.
    // Every prior name still reaches the current name in any workspace.
    const previous = chain.indexOf(to);
    if (previous !== -1) chain.splice(previous, 1);
    chain.push(to);
  }
  const objects = [...state, ...existing.flatMap(({ from, to }) => [from, to])];
  for (const buckets of chains.filter((entries) => entries.every((address) => assetKey(address) !== undefined))) {
    const names = buckets.map((address) => assetKey(address)!);
    const files = new Set(objects.flatMap((address) => {
      const key = objectKey(address);
      const name = names.find((name) => key?.startsWith(`${name}/`));
      return name === undefined ? [] : [key!.slice(name.length + 1)];
    }));
    chains = chains.filter((entries) => !entries.some((address) => names.some((name) => objectKey(address)?.startsWith(`${name}/`))));
    for (const file of files) chains.push(names.map((name) => `yandex_storage_object.assets[${JSON.stringify(`${name}/${file}`)}]`));
  }
  const moves = chains.flatMap((entries) => entries.slice(1).map((to, index) => ({ from: entries[index], to })));
  const declared = declaredAddresses(config);
  for (const { from, to } of moves) {
    const key = objectKey(from)?.split("/")[0];
    if (declared.has(from) || (key !== undefined && Object.hasOwn(config.assets ?? {}, key))) {
      throw new Error(`Cannot reuse ${from}: its rename to ${to} is retained for other states. Use a new name, or retire this history only after every affected state has migrated.`);
    }
  }
  const blocks = moves.map(({ from, to }) => `moved {\n  from = ${toHcl(from)}\n  to   = ${toHcl(to)}\n}`).join("\n");
  return `${remainder.trim()}${blocks ? `\n${blocks}` : ""}\n`;
}

function moveChains(moves: TerraformMove[]): string[][] {
  const next = new Map<string, string>();
  const previous = new Map<string, string>();
  for (const { from, to } of moves) {
    if ((next.has(from) && next.get(from) !== to) || (previous.has(to) && previous.get(to) !== from)) {
      throw new Error("Terraform rename history branches; resolve the conflicting moved blocks before editing");
    }
    next.set(from, to);
    previous.set(to, from);
  }
  const chains: string[][] = [];
  const visited = new Set<string>();
  for (const from of next.keys()) {
    if (previous.has(from)) continue;
    const chain = [from];
    while (next.has(chain.at(-1)!)) {
      const current = chain.at(-1)!;
      if (visited.has(current)) throw new Error("Terraform rename history contains a cycle");
      visited.add(current);
      chain.push(next.get(current)!);
    }
    chains.push(chain);
  }
  if (visited.size !== next.size) throw new Error("Terraform rename history contains a cycle");
  return chains;
}

async function stateAddresses(infra: string, readCommand: OutputReader, sourceEnvironment: NodeJS.ProcessEnv): Promise<Set<string>> {
  let source: string;
  const environment = {
    ...sourceEnvironment,
    TF_CLI_CONFIG_FILE: join(infra, "terraform.rc"),
    TF_IN_AUTOMATION: "true",
    TF_INPUT: "0",
  };
  const pull = () => readCommand("terraform", [`-chdir=${infra}`, "state", "pull"], environment);
  try {
    try {
      source = await pull();
    } catch (error) {
      if (!/Required plugins are not installed|Backend initialization required/i.test(String(error))) throw error;
      await readCommand("terraform", [`-chdir=${infra}`, "init", "-input=false", "-lockfile=readonly"], environment);
      source = await pull();
    }
  } catch (cause) {
    throw new Error("Cannot read the configured Terraform backend for resource renames. Initialize/authenticate that backend and retry; no rename was applied.", { cause });
  }
  // `state pull` succeeds with empty output when the selected backend has no state.
  if (!source.trim()) return new Set();
  const state = JSON.parse(source) as { resources?: Array<{ mode: string, module?: string, type: string, name: string, instances?: Array<{ index_key?: string | number }> }> };
  if (!Array.isArray(state.resources)) throw new Error("Terraform backend state has no resource list; cannot reconcile resource renames");
  return new Set(state.resources.filter((resource) => resource.mode === "managed" && !resource.module)
    .flatMap((resource) => (resource.instances ?? []).map((instance) => `${resource.type}.${resource.name}[${JSON.stringify(instance.index_key)}]`)));
}

function resourceKey(address: string, resource: string): string | undefined {
  const prefix = `${resource}[`;
  if (!address.startsWith(prefix) || !address.endsWith("]")) return undefined;
  const key: unknown = JSON.parse(address.slice(prefix.length, -1));
  return typeof key === "string" ? key : undefined;
}

const assetKey = (address: string) => resourceKey(address, "yandex_storage_bucket.assets");
const objectKey = (address: string) => resourceKey(address, "yandex_storage_object.assets");

function declaredAddresses(config: VibecloudConfig): Set<string> {
  const result = new Set<string>();
  const add = (resource: string, key: string) => result.add(`${resource}[${JSON.stringify(key)}]`);
  for (const key of Object.keys(config.assets ?? {})) add("yandex_storage_bucket.assets", key);
  for (const key of Object.keys(config.buckets ?? {})) add("yandex_storage_bucket.buckets", key);
  for (const [key, database] of Object.entries(config.databases ?? {})) {
    add("yandex_ydb_database_serverless.databases", key);
    for (const stream of Object.keys(database.streams ?? {})) add("yandex_ydb_topic.streams", `${key}.${stream}`);
  }
  for (const key of Object.keys(compileDeploymentPlan(config).function_groups)) {
    add("yandex_function.functions", key);
    add("yandex_function_iam_binding.invoker", key);
  }
  for (const [key, definition] of Object.entries(config.functions ?? {})) {
    if (definition.cron) add("yandex_function_trigger.crons", key);
    for (const trigger of definition.triggers ?? []) add("yandex_function_trigger.triggers", `${key}/${trigger.stream}`);
  }
  for (const key of Object.keys(config.secrets?.entries ?? {})) add("yandex_lockbox_secret_version.application", key);
  return result;
}
