import { parseRequest, invocationSignal, errorResponse, rateHeaders, json, environmentInteger, requiredEnvironment } from "@vibecloud/ai/http";
import { createObjectStorage } from "@vibecloud/storage";
import { randomUUID } from "node:crypto";
import {
  AI_IMAGE_MODEL,
  AI_IMAGE_MAX_PROMPT_CHARS,
  AI_IMAGE_SIZES,
  AIStudioRequestError,
  createAIStudioClient,
  createAIRateLimiter,
  requireAIStudioImage,
  type AIStudioImageSize,
} from "@vibecloud/ai";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { structuredLog, withSpan } from "@vibecloud/telemetry";

interface ImageRequest {
  prompt?: unknown
  size?: unknown
}

const rateLimiter = createAIRateLimiter({
  requestsPerMinute: environmentInteger("VIBECLOUD_AI_IMAGE_REQUESTS_PER_MINUTE", 5),
});

export async function handler(event: HttpEvent, context: InvocationContext): Promise<HttpResponse> {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" }, { allow: "POST" });
  const request = parseRequest<ImageRequest>(event);
  if (!request || Object.keys(request).some((key) => !["prompt", "size"].includes(key))) {
    return json(400, { error: "body must contain prompt and optional size" });
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    return json(400, { error: "prompt must be a non-empty string" });
  }
  const prompt = request.prompt.trim();
  if ([...prompt].length > AI_IMAGE_MAX_PROMPT_CHARS) {
    return json(413, { error: `prompt must not exceed ${AI_IMAGE_MAX_PROMPT_CHARS} characters` });
  }
  if (request.size !== undefined && !AI_IMAGE_SIZES.includes(request.size as AIStudioImageSize)) {
    return json(400, { error: `size must be one of: ${AI_IMAGE_SIZES.join(", ")}` });
  }
  try {
    const access = rateLimiter.check(event.requestContext?.identity?.sourceIp ?? "unknown");
    const storage = createObjectStorage(context, { bucket: requiredEnvironment("{{BUCKET_ENV}}_BUCKET") });
    const ai = createAIStudioClient(context);
    const model = process.env.YANDEX_AI_IMAGE_MODEL ?? AI_IMAGE_MODEL;
    const response = await withSpan("ai.images.generate", { "gen_ai.request.model": model }, () => (
      ai.images.generate({ prompt, model, ...(request.size ? { size: request.size as AIStudioImageSize } : {}) }, {
        signal: invocationSignal(context),
      })
    ));
    const { image, contentType } = requireAIStudioImage(response);
    const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
    const stored = await storage.put(`images/${randomUUID()}.${extension}`, image, {
      contentType, signal: invocationSignal(context), cacheControl: "public, max-age=31536000, immutable",
    });
    return json(200, stored, { ...rateHeaders(access), "cache-control": "no-store" });
  } catch (error) {
    if (error instanceof AIStudioRequestError) {
      structuredLog("ERROR", "AI Studio image request rejected", {
        "upstream.status": error.status,
        "upstream.request_id": error.requestId,
        "upstream.message": error.message.replaceAll(prompt, "[prompt omitted]"),
      });
    }
    return errorResponse(error);
  }
}
