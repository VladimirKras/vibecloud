import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "./commands.ts";
import { instances, type PublicationState } from "./publication.ts";

/** One-time migration from the LIVE specification, never the provider's stale spec. */
export async function pinLegacyInvokers(state: PublicationState, directory: string, environment: NodeJS.ProcessEnv, run: CommandRunner) {
  const versions = new Map(instances(state, "yandex_function", "functions").map(({ attributes }) => [attributes.id as string, attributes.version as string]));
  const tagged = new Set<string>();
  const pin = async (id: string) => {
    const version = versions.get(id);
    if (!version) throw new Error(`Cannot pin deployed function ${id}: its version is missing from Terraform state`);
    const tag = `vc-${version}`;
    if (!tagged.has(version)) {
      await run("yc", ["serverless", "function", "version", "set-tag", "--id", version, "--tag", tag], environment);
      tagged.add(version);
    }
    return tag;
  };
  for (const { attributes } of instances(state, "yandex_api_gateway", "gateway")) {
    const spec = JSON.parse(attributes.spec);
    let changed = false;
    for (const path of Object.values(spec.paths ?? {}) as Array<Record<string, { "x-yc-apigateway-integration"?: { type: string, function_id: string, tag?: string } }>>) {
      for (const operation of Object.values(path)) {
        const integration = operation?.["x-yc-apigateway-integration"];
        if (integration?.type !== "cloud_functions" || (integration.tag && integration.tag !== "$latest")) continue;
        integration.tag = await pin(integration.function_id);
        changed = true;
      }
    }
    if (changed) {
      const file = join(directory, "previous-gateway.json");
      await writeFile(file, JSON.stringify(spec));
      await run("yc", ["serverless", "api-gateway", "update", "--id", attributes.id, "--spec", file], environment);
    }
  }
  for (const [name, kind] of [["crons", "timer"], ["triggers", "yds"]]) {
    for (const { attributes } of instances(state, "yandex_function_trigger", name)) {
      const invocation = attributes.function?.[0];
      if (!invocation || (invocation.tag && invocation.tag !== "$latest")) continue;
      const tag = await pin(invocation.id);
      await run("yc", ["serverless", "trigger", "update", kind, "--id", attributes.id, "--new-invoke-function-tag", tag], environment);
    }
  }
}
