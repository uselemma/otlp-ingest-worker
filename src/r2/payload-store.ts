
import { AwsClient } from "aws4fetch";

import {
  OTLP_PAYLOAD_POINTER_VERSION,
  sha256Hex,
} from "../shared/common/index";

import {
  getPayloadKeyPrefix,
  resolveS3Config,
  type Env,
} from "../config";

function buildKey(prefix: string, projectId: string, hash: string): string {
  return `${prefix}/${projectId}/${hash.slice(0, 32)}/${Date.now()}`;
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
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

  const s3 = await resolveS3Config(env);
  const client = new AwsClient({
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    region: s3.region,
    service: "s3",
  });

  const url = `${s3.endpoint}/${s3.otelBucket}/${encodeKeyPath(key)}`;
  const response = await client.fetch(url, {
    method: "PUT",
    body: toStandaloneArrayBuffer(body),
    headers: {
      "Content-Type": contentType,
      "Content-Encoding": "gzip",
      "x-amz-meta-project_id": projectId,
      "x-amz-meta-requested_at": requestedAt,
      "x-amz-meta-content_type": contentType,
      "x-amz-meta-version": String(OTLP_PAYLOAD_POINTER_VERSION),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 512);
    throw new Error(
      `Payload upload failed (${response.status}) for ${key}: ${detail}`,
    );
  }

  return key;
}

function toStandaloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}