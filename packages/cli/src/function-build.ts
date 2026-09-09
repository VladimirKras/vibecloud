import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { build as esbuild } from "esbuild";
import { orderFunctionRoutes, type FunctionDeclaration } from "./function-groups.ts";

import { compileDeploymentPlan, type DeploymentPlan } from "./deployment-plan.ts";
export { compileDeploymentPlan, functionProxyPatterns } from "./deployment-plan.ts";
export type { DeploymentPlan } from "./deployment-plan.ts";

export type { FunctionDeclaration } from "./function-groups.ts";

const excluded = new Set([".DS_Store", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv", "__pycache__"]);

/** Compile deployment groups while retaining authored handler directories. */
export async function buildFunctionGroups(project: string, declaration: FunctionDeclaration, build: typeof esbuild, {
  outputDirectory = join(project, "dist"), plan = compileDeploymentPlan(declaration),
}: { outputDirectory?: string, plan?: DeploymentPlan } = {}) {
  const groups = Object.fromEntries(Object.entries(plan.function_groups).map(([key, { members, ...group }]) => [key, {
    ...group, functions: Object.fromEntries(members.map((name) => [name, declaration.functions![name]])),
  }]));
  for (const [key, group] of Object.entries(groups)) {
    const output = join(outputDirectory, "functions", key);
    await mkdir(output, { recursive: true });
    const entries = Object.entries(group.functions);
    const native = /^(nodejs|python|golang)/.test(group.runtime);
    if (!native && entries.length > 1) {
      const manifest = join(output, "handlers.json");
      await writeFile(manifest, JSON.stringify({ ...group, routes: declaration.gateway.routes ?? [] }));
      await buildArtifact(project, "function", key, entries[0][1].build!, output, manifest);
      continue;
    }
    const modules: Record<string, string> = {};
    for (const [index, [name, definition]] of entries.entries()) {
      const source = join(project, "src", "functions", name);
      const member = (group.kind === "stream" && !(definition.build && group.runtime.startsWith("nodejs"))) || !native ? output : join(output, "handlers", `h${index}`);
      if (definition.build) await buildArtifact(project, "function", name, definition.build, member);
      const module = definition.handler.slice(0, definition.handler.lastIndexOf("."));
      if (group.runtime.startsWith("nodejs")) {
        const entryDirectory = dirname(join(output, group.handler.slice(0, group.handler.lastIndexOf(".")) + ".js"));
        modules[name] = definition.build ? `./${relative(entryDirectory, join(member, `${module}.js`))}` : join(source, `${module}.ts`);
      } else {
        if (!definition.build) await cp(source, member, { recursive: true, filter: (path) => !excluded.has(basename(path)) });
        modules[name] = member;
      }
    }
    if (!native) continue;
    const routes = orderFunctionRoutes((declaration.gateway.routes ?? [])
      .filter((route) => route.function && Object.hasOwn(group.functions, route.function))
      .map((route) => ({ ...route, method: (route.method ?? "ANY").toUpperCase() })));
    const timers = Object.fromEntries(entries.filter(([, definition]) => definition.cron).map(([name, definition]) => [name, { payload: definition.cron!.payload }]));
    const manifest = { kind: group.kind, routes, timers };
    if (group.runtime.startsWith("nodejs")) {
      const instrument = [declaration.observability?.logs, declaration.observability?.metrics, declaration.observability?.traces].some((signal) => signal?.enabled);
      const loaders = entries.map(([name, definition]) => {
        const exported = definition.handler.slice(definition.handler.lastIndexOf(".") + 1);
        return `${JSON.stringify(name)}: async () => { const module = await import(${JSON.stringify(modules[name])}); return ${instrument ? `instrumentFunction(module[${JSON.stringify(exported)}])` : `module[${JSON.stringify(exported)}]`}; }`;
      });
      const router = fileURLToPath(new URL("./function-router.js", import.meta.url));
      const contents = `${instrument ? 'import { instrumentFunction } from "@vibecloud/telemetry";' : ""}
const handlers = {${loaders.join(",")}};
${group.kind === "stream"
  ? `export const ${group.handler.split(".").at(-1)} = async (event, context) => (await handlers[${JSON.stringify(entries[0][0])}]())(event, context);`
  : `import { createFunctionRouter } from ${JSON.stringify(router)};
export const handler = createFunctionRouter(${JSON.stringify(group.kind)}, ${JSON.stringify(routes)}, handlers, ${JSON.stringify(timers)});`}`;
      const module = group.handler.slice(0, group.handler.lastIndexOf("."));
      await build({ stdin: { contents, resolveDir: project, sourcefile: `${key}-entry.ts`, loader: "ts" },
        outfile: join(output, `${module}.js`), bundle: true, platform: "node", format: "cjs",
        external: entries.filter(([, definition]) => definition.build).map(([name]) => modules[name]),
        target: `node${group.runtime.slice("nodejs".length)}`, sourcemap: declaration.observability?.source_maps ?? false });
      await writeFile(join(output, "package.json"), '{"type":"commonjs"}\n');
    } else if (group.kind !== "stream" && group.runtime.startsWith("python")) {
      await writeFile(join(output, "handlers", "__init__.py"), "");
      for (const member of Object.values(modules)) {
        try {
          await writeFile(join(member, "__init__.py"), "", { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const handlers = Object.fromEntries(entries.map(([name, definition], index) => [name, { module: `handlers.h${index}.${definition.handler.split(".")[0]}`, exported: definition.handler.split(".")[1] }]));
      await writeFile(join(output, "router.json"), JSON.stringify({ ...manifest, handlers }));
      await cp(new URL("../templates/runtime/router.py", import.meta.url), join(output, "router.py"));
      const requirements = await Promise.all(Object.values(modules).map(async (member) => {
        try {
          await stat(join(member, "requirements.txt"));
          return `-r ${relative(output, join(member, "requirements.txt"))}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        }
      }));
      // Pip resolves the combined constraints and rejects incompatible dependencies.
      await writeFile(join(output, "requirements.txt"), requirements.join("\n"));
    } else if (group.kind !== "stream") {
      const imports: string[] = [];
      const handlers: string[] = [];
      const requirements: string[] = [];
      const replacements: string[] = [];
      const moduleNames = new Set<string>();
      let goVersion = "1.23";
      for (const [index, [name, definition]] of entries.entries()) {
        const member = modules[name];
        const mod = await readFile(join(member, "go.mod"), "utf8");
        const moduleName = /^module\s+(\S+)/m.exec(mod)?.[1];
        if (!moduleName) throw new Error(`Missing module declaration for ${name}`);
        if (moduleNames.has(moduleName)) throw new Error(`Go handlers in ${key} need distinct module paths; ${name} repeats ${moduleName}`);
        moduleNames.add(moduleName);
        const version = /^go\s+([\d.]+)/m.exec(mod)?.[1];
        if (version && version.localeCompare(goVersion, undefined, { numeric: true }) > 0) goVersion = version;
        imports.push(`h${index} ${JSON.stringify(moduleName)}`);
        handlers.push(`${JSON.stringify(name)}: h${index}.${definition.handler.split(".")[1]}`);
        requirements.push(`${moduleName} ${/\/v(\d+)$/.exec(moduleName)?.[1] ? `v${/\/v(\d+)$/.exec(moduleName)![1]}.0.0` : "v0.0.0"}`);
        replacements.push(`${moduleName} => ./handlers/h${index}`);
        for (const file of await readdir(member)) {
          if (!file.endsWith(".go")) continue;
          const path = join(member, file);
          await writeFile(path, (await readFile(path, "utf8")).replace(/^package\s+main\b/m, "package handler"));
        }
      }
      await writeFile(join(output, "go.mod"), `module vibecloud.local/router\n\ngo ${goVersion}\n\nrequire (\n${requirements.join("\n")}\n)\nreplace (\n${replacements.join("\n")}\n)\n`);
      const template = await readFile(new URL("../templates/runtime/router.go", import.meta.url), "utf8");
      await writeFile(join(output, "router.go"), template.replace("// HANDLER_IMPORTS", imports.join("\n")).replace("// HANDLERS", handlers.join(",\n") + ",").replace("\"MANIFEST\"", JSON.stringify(JSON.stringify(manifest))));
    }
  }
}

/** Custom functions and assets share the same command and artifact contract. */
export async function buildArtifact(project: string, kind: "function" | "asset", name: string, build: { command: string, cwd?: string }, output: string, manifest?: string, environment: NodeJS.ProcessEnv = {}) {
  const prefix = `VIBECLOUD_${kind.toUpperCase()}`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(build.command, { cwd: resolve(project, build.cwd ?? "."), shell: true, stdio: "inherit",
      env: { ...process.env, ...environment, [`${prefix}_NAME`]: name, [`${prefix}_SOURCE`]: join(project, "src", `${kind}s`, manifest ? "" : name), [`${prefix}_OUTPUT`]: output,
        ...(manifest ? { VIBECLOUD_FUNCTION_MANIFEST: manifest } : {}) } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`custom build for ${name} failed: ${signal ?? code}`)));
  });
  if (!(await stat(output)).isDirectory()) throw new Error(`custom build for ${name} did not create ${output}`);
  if (kind === "function" && !(await readdir(output)).some((file) => !manifest || file !== basename(manifest))) throw new Error(`custom build for ${name} produced no artifacts`);
}
