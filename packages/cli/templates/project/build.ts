import { buildApplication } from "@vibecloud/cli/build";

await buildApplication(new URL(".", import.meta.url));
