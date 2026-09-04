import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const declaration = JSON.parse(readFileSync(
  process.env.VIBECLOUD_CONFIG_PATH ?? resolve("infra/vibecloud.auto.tfvars.json"),
  "utf8",
));
const proxy = Object.fromEntries((declaration.gateway?.routes ?? [])
  .filter((route: { function?: string, method?: string }) => (
    route.function && (route.method ?? "ANY").toUpperCase() !== "WS"
  ))
  .map((route: { pattern: string }) => [
    route.pattern.endsWith("*")
      ? `^${escapeRegex(route.pattern.slice(0, -1))}`
      : `^${escapeRegex(route.pattern)}$`,
    {
      target: "http://127.0.0.1:8787",
      changeOrigin: false,
      xfwd: true,
    },
  ]));

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [".orb.local"],
    proxy,
    watch: process.env.VIBECLOUD_DEV_CONTAINER === "1"
      ? { usePolling: true, interval: 250 }
      : undefined,
  },
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
