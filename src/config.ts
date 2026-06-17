type SecretsStoreBinding = {
  get: () => Promise<string>;
};

type EnvSecretValue = string | SecretsStoreBinding;

/** Payload pointer posted to the Lemma API's `POST /otlp/enqueue`. */
export interface OtelSpanInsertPointer {
  project_id: string;
  requested_at: string;
  payload_key: string;
  payload_format: string;
  version: number;
}

export interface Env {
  LEMMA_API_URL?: string;

  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_OTEL_BUCKET?: string;

  OTEL_PUT_ACCESS_KEY_ID?: EnvSecretValue;
  OTEL_PUT_SECRET_ACCESS_KEY?: EnvSecretValue;

  OTEL_PAYLOAD_KEY_PREFIX?: string;
  OTEL_PAYLOAD_TTL_SECONDS?: string;
  OTEL_WORKER_AUTH_TOKEN?: string;

  WORKER_SHARED_SECRET?: EnvSecretValue;

  PROCESSOR_BUFFERED_REPARENT_INACTIVITY_MS?: string;
  PROCESSOR_BUFFERED_REPARENT_MAX_BUFFER_MS?: string;
  PROCESSOR_BUFFERED_REPARENT_MAX_SPANS_PER_TRACE?: string;
  PROCESSOR_BUFFERED_REPARENT_MAX_DISPATCH_RETRIES?: string;
  PROCESSOR_BUFFERED_REPARENT_DEBUG_PAYLOADS?: string;
  PROCESSOR_BUFFERED_REPARENT_DEBUG_PAYLOAD_PREFIX?: string;
  OTEL_BUCKET: R2Bucket;
  TRACE_BUFFER: DurableObjectNamespace;
}

const REQUIRED_ENV_KEYS = [
  'WORKER_SHARED_SECRET',
  'S3_ENDPOINT',
  'S3_REGION',
  'OTEL_PUT_ACCESS_KEY_ID',
  'OTEL_PUT_SECRET_ACCESS_KEY',
] as const;

let resolvedEnvPromise: Promise<Env> | null = null;

function getMissingRequiredKeys(env: Env): string[] {
  return REQUIRED_ENV_KEYS.filter(key => {
    const value = env[key];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    return false;
  });
}

function isSecretsStoreBinding(value: unknown): value is SecretsStoreBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

async function resolveEnvSecretValue(
  value: EnvSecretValue | undefined
): Promise<string | undefined> {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isSecretsStoreBinding(value)) {
    const resolved = await value.get();
    const trimmed = resolved.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

async function resolveAndValidateEnv(env: Env): Promise<Env> {
  const workerSharedSecret = await resolveEnvSecretValue(
    env.WORKER_SHARED_SECRET
  );
  const otelPutAccessKeyId = await resolveEnvSecretValue(
    env.OTEL_PUT_ACCESS_KEY_ID
  );
  const otelPutSecretAccessKey = await resolveEnvSecretValue(
    env.OTEL_PUT_SECRET_ACCESS_KEY
  );
  const normalizedEnv = {
    ...env,
    WORKER_SHARED_SECRET: workerSharedSecret ?? '',
    OTEL_PUT_ACCESS_KEY_ID: otelPutAccessKeyId ?? '',
    OTEL_PUT_SECRET_ACCESS_KEY: otelPutSecretAccessKey ?? '',
  } as Env;

  const missing = getMissingRequiredKeys(normalizedEnv);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  return normalizedEnv;
}

export async function resolveEnv(env: Env): Promise<Env> {
  const hasUnresolvedRequiredBinding = REQUIRED_ENV_KEYS.some(key =>
    isSecretsStoreBinding(env[key])
  );
  if (
    getMissingRequiredKeys(env).length === 0 &&
    !hasUnresolvedRequiredBinding
  ) {
    return env;
  }

  if (!resolvedEnvPromise) {
    const pending = resolveAndValidateEnv(env);
    pending.catch(() => {
      if (resolvedEnvPromise === pending) {
        resolvedEnvPromise = null;
      }
    });
    resolvedEnvPromise = pending;
  }
  return resolvedEnvPromise;
}

export function getPayloadTtlSeconds(env: Env): number {
  const raw = Number(env.OTEL_PAYLOAD_TTL_SECONDS ?? 3600);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 3600;
  }
  return Math.trunc(raw);
}

export function getPayloadKeyPrefix(env: Env): string {
  return env.OTEL_PAYLOAD_KEY_PREFIX?.trim() || 'otel:payload:v1';
}

export interface S3Config {
  endpoint: string;
  region: string;
  otelBucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function asTrimmedString(value: EnvSecretValue | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function resolveS3Config(env: Env): Promise<S3Config> {
  const resolved = await resolveEnv(env);
  const endpoint = resolved.S3_ENDPOINT?.trim();
  const region = resolved.S3_REGION?.trim();
  const accessKeyId = asTrimmedString(resolved.OTEL_PUT_ACCESS_KEY_ID);
  const secretAccessKey = asTrimmedString(resolved.OTEL_PUT_SECRET_ACCESS_KEY);
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Payload store is not configured: S3_ENDPOINT, S3_REGION, OTEL_PUT_ACCESS_KEY_ID, OTEL_PUT_SECRET_ACCESS_KEY are required'
    );
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    region,
    otelBucket: resolved.S3_OTEL_BUCKET?.trim() || 'otel',
    accessKeyId,
    secretAccessKey,
  };
}
