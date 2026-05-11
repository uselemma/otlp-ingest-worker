import {
  OTLP_PAYLOAD_POINTER_VERSION,
  sha256Hex,
} from "../shared/common/index";

import { getPayloadKeyPrefix, type Env } from "../config";

function buildKey(prefix: string, projectId: string, hash: string): string {
  return `${prefix}/${projectId}/${hash.slice(0, 32)}/${Date.now()}`;
}

export async function putPayload(
  env: Env,
  projectId: string,
  body: Uint8Array,
  requestedAt: string,
  contentType = "application/x-protobuf",
): Promise<string> {
  const prefix = getPayloadKeyPrefix(env);
  const hashSeed = `${projectId}:${body.byteLength}:${requestedAt}`;
  const hash = await sha256Hex(hashSeed);
  const key = buildKey(prefix, projectId, hash);

  await env.OTEL_BUCKET.put(key, body, {
    customMetadata: {
      project_id: projectId,
      requested_at: requestedAt,
      content_type: contentType,
      version: String(OTLP_PAYLOAD_POINTER_VERSION),
    },
    httpMetadata: {
      contentType,
      contentEncoding: "gzip",
    },
  });

  return key;
}
