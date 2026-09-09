import { functionProxyPatterns } from "./deployment-plan.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Merge these defaults with app-specific Vite plugins and settings. */
export function localViteConfig(project = process.cwd(), environment = process.env) {
  const declaration = JSON.parse(readFileSync(resolve(project, environment.VIBECLOUD_CONFIG_PATH ?? "infra/vibecloud.auto.tfvars.json"), "utf8"));
  return {
    server: {
      allowedHosts: [".orb.local"],
      proxy: Object.fromEntries(["^/_vibecloud/media/", ...functionProxyPatterns(declaration.gateway?.routes ?? [])].map((pattern) => [pattern, {
        target: "http://127.0.0.1:8787", changeOrigin: false, xfwd: true,
      }])),
      watch: environment.VIBECLOUD_DEV_CONTAINER === "1" ? { usePolling: true, interval: 250 } : undefined,
    },
  };
}
