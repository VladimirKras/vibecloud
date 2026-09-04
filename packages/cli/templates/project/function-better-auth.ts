import { getYdb, withYdb } from "@vibecloud/db";
import { ydbAdapter } from "@vibecloud/db/better-auth";
import type { HttpEvent, HttpResponse } from "@vibecloud/function-api";
import { betterAuth } from "better-auth";

const endpoint = requiredEnvironment("{{DATABASE_ENV}}_ENDPOINT");
const secret = requiredEnvironment("BETTER_AUTH_SECRET");

const auth = betterAuth({
  appName: {{PROJECT_NAME_JSON}},
  secret,
  baseURL: {
    allowedHosts: ["*.apigw.yandexcloud.net", "*.orb.local", "127.0.0.1:*", "localhost:*"],
    protocol: "auto",
  },
  trustedOrigins: (request) => request ? [new URL(request.url).origin] : [],
  database: ydbAdapter({ getDb: getYdb }),
  emailAndPassword: { enabled: true },
});

export async function {{HANDLER}}(
  event: HttpEvent,
): Promise<HttpResponse> {
  return withYdb(endpoint, async () => responseFor(await auth.handler(requestFrom(event))));
}

function requestFrom(event: HttpEvent): Request {
  const host = header(event, "x-forwarded-host") ?? header(event, "host") ?? "localhost";
  const forwardedProtocol = header(event, "x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const localHost = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.includes(".orb.local");
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : localHost ? "http" : "https";
  const url = new URL(event.path, `${protocol}://${host}`);
  for (const [name, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
    for (const value of values) url.searchParams.append(name, value);
  }
  if (!event.multiValueQueryStringParameters) {
    for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
      url.searchParams.append(name, value);
    }
  }

  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values) headers.append(name, value);
  }
  for (const [name, value] of Object.entries(event.headers)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  const body = event.httpMethod === "GET" || event.httpMethod === "HEAD"
    ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  return new Request(url, { method: event.httpMethod, headers, body });
}

async function responseFor(response: Response): Promise<HttpResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { multiValueHeaders: { "set-cookie": cookies } } : {}),
    body: await response.text(),
  };
}

function header(event: HttpEvent, requested: string): string | undefined {
  const name = Object.keys(event.headers).find((candidate) => candidate.toLowerCase() === requested);
  return name ? event.headers[name] : undefined;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
