import { parseRequest, invocationSignal, errorResponse, rateHeaders, json, environmentInteger, requestHeaders, requiredEnvironment, waitForAIResponse, usageAttributes } from "@vibecloud/ai/http";
import {
  createAIContinuation,
  createAIStudioClient,
  createAIRateLimiter,
  readAIContinuation,
  requireAIStudioOutputText,
} from "@vibecloud/ai";
import { withYdb } from "@vibecloud/db";
import { createYdbAuth } from "@vibecloud/db/better-auth";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { businessEvent, setSpanAttributes, withSpan } from "@vibecloud/telemetry";

interface AgentRequest {
  prompt?: unknown
  continuation?: unknown
  previousResponseId?: unknown
}

const databaseEndpoint = requiredEnvironment("{{DATABASE_ENV}}_ENDPOINT");
const authSecret = requiredEnvironment("BETTER_AUTH_SECRET");
const rateLimiter = createAIRateLimiter();
const auth = createYdbAuth({{PROJECT_NAME_JSON}}, authSecret);

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  try {
    return await handle(event, context);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handle(event: HttpEvent, context: InvocationContext): Promise<HttpResponse> {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" }, { allow: "POST" });
  const session = await withYdb(databaseEndpoint, () => auth.api.getSession({
    headers: requestHeaders(event),
    query: { disableCookieCache: true, disableRefresh: true },
  }));
  if (!session) return json(401, { error: "Sign in with Better Auth" });
  const access = rateLimiter.check(session.user.id);

  const request = parseRequest<AgentRequest>(event);
  if (!request) return json(400, { error: "body must be a JSON object" }, rateHeaders(access));
  if (request.previousResponseId !== undefined) {
    return json(400, { error: "previousResponseId is not accepted; use the signed continuation value" }, rateHeaders(access));
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    return json(400, { error: "prompt must be a non-empty string" }, rateHeaders(access));
  }
  const prompt = request.prompt.trim();
  if (prompt.length > environmentInteger("VIBECLOUD_AI_MAX_PROMPT_CHARS", 8_000)) {
    return json(413, { error: "prompt is too long" }, rateHeaders(access));
  }
  if (request.continuation !== undefined && typeof request.continuation !== "string") {
    return json(400, { error: "continuation must be a string" }, rateHeaders(access));
  }
  const previousResponseId = request.continuation
    ? readAIContinuation(request.continuation, session.user.id, authSecret)
    : undefined;
  const modelName = process.env.YANDEX_AI_MODEL ?? "aliceai-llm";
  const ai = createAIStudioClient(context);
  const response = await withSpan("ai.responses.create", {
    "gen_ai.request.model": modelName,
  }, async () => {
    const signal = invocationSignal(context);
    const initial = await ai.responses.create({
      model: ai.model(modelName),
      instructions: process.env.YANDEX_AI_INSTRUCTIONS ?? "Answer clearly and concisely.",
      input: prompt,
      max_output_tokens: environmentInteger("VIBECLOUD_AI_MAX_OUTPUT_TOKENS", 1_024),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    }, { signal });
    return waitForAIResponse(ai, initial, signal);
  });
  const output = requireAIStudioOutputText(response);
  setSpanAttributes(usageAttributes(modelName, response.usage));
  businessEvent("ai.response.completed", { "ai.response.id": response.id });
  return json(200, {
    id: response.id,
    continuation: createAIContinuation(
      response.id,
      session.user.id,
      authSecret,
      environmentInteger("VIBECLOUD_AI_CONTINUATION_TTL_SECONDS", 3_600),
    ),
    output,
  }, rateHeaders(access));
}
