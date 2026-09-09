import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pinLegacyInvokers } from "./legacy-publication.ts";
import { spawnCommand } from "./commands.ts";
import { loadProjectMigrator } from "./project-migrator.ts";

// Private adapters for effects Terraform cannot express natively. Terraform
// invokes these through its own graph while holding its own backend lock.
const [action, argument] = process.argv.slice(2);
if (action === "pin" && argument) {
  const state = JSON.parse(await readFile(argument, "utf8"));
  if (!Array.isArray(state.resources)) throw new Error("Invalid publication manifest");
  await pinLegacyInvokers(state, dirname(argument), process.env, spawnCommand);
} else if (action === "migrate" && argument) {
  const value = JSON.parse(argument) as { project: string, connection: string, directory: string };
  if (![value.project, value.connection, value.directory].every((item) => typeof item === "string" && item)) throw new Error("Invalid migration input");
  const migrator = await loadProjectMigrator(value.project);
  await migrator.migrateYdbFolder(value.connection, value.directory, { accessToken: process.env.YDB_ACCESS_TOKEN_CREDENTIALS ?? process.env.YC_TOKEN });
} else throw new Error("Invalid Terraform adapter invocation");
