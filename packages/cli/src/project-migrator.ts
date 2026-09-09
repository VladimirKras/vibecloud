import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadProjectMigrator(root: string) {
  try {
    const require = createRequire(join(root, "package.json"));
    return await import(pathToFileURL(require.resolve("@vibecloud/db/migrator")).href) as {
      migrateYdbFolder(connection: string, folder: string, options?: { accessToken?: string, recovery?: "retry" }): Promise<void>
    };
  } catch (cause) {
    throw new Error("YDB migrations require @vibecloud/db. Run pnpm install and retry.", { cause });
  }
}
