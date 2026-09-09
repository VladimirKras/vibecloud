import { localViteConfig } from "@vibecloud/cli/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, mergeConfig } from "vite";

export default defineConfig(mergeConfig(localViteConfig(), { plugins: [react()] }));
