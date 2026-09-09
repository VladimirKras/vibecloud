import { compileDeploymentPlan } from "./deployment-plan.ts";
import type { LoadedConfig } from "./config.ts";
import { LOCAL_OWNER_LABEL } from "./local-runtime.ts";
import { localResourceNames } from "./local-identities.ts";

export function requiresLocalAi(loaded: LoadedConfig, environment: NodeJS.ProcessEnv): boolean {
  return environment.VIBECLOUD_LOCAL_AI === "1"
    || Object.values(compileDeploymentPlan(loaded.config).ai).some(Boolean);
}

export async function localDatabases(loaded: LoadedConfig, project = process.env.VIBECLOUD_COMPOSE_PROJECT ?? loaded.config.name) {
  const names = compileDeploymentPlan(loaded.config).databases;
  const identities = await localResourceNames(loaded.rootDirectory, "databases", loaded.config.databases);
  return Object.fromEntries(names.map((name) => {
    const service = identities[name];
    const host = `${service}.${project}.orb.local`;
    return [name, {
      service,
      endpoint: `grpc://${service}:2136/local`,
      publicEndpoint: `grpc://${host}:2136/local`,
      uiUrl: `http://${host}`,
    }];
  }));
}

/** Each logical database gets its own process and persistent volumes. */
export async function localServicesCompose(loaded: LoadedConfig, identity?: { owner: string, project: string }) {
  const databases = Object.values(await localDatabases(loaded, identity?.project));
  const labels = identity ? { [LOCAL_OWNER_LABEL]: identity.owner } : {};
  return {
    services: {
      ...Object.fromEntries(databases.map(({ service }) => [service, {
        image: "ydbplatform/local-ydb:latest",
        hostname: "localhost",
        platform: "linux/amd64",
        labels: { ...labels, "dev.orbstack.http-port": "8765" },
        volumes: [`${service}-certs:/ydb_certs`, `${service}-data:/ydb_data`],
      }])),
      app: {
        labels,
        depends_on: Object.fromEntries(databases.map(({ service }) => [service, { condition: "service_healthy" }])),
      },
    },
    networks: { default: { labels } },
    volumes: Object.fromEntries([
      ...databases.flatMap(({ service }) => [[`${service}-certs`, { labels }], [`${service}-data`, { labels }]]),
      ...(identity ? [["app-node-modules", { labels }], ["pnpm-store", { labels }], ["app-runtime", { labels }]] : []),
    ]),
  };
}
