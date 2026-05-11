import { InfisicalSDK } from "@infisical/sdk";

type SecretsStoreBinding = {
  get: () => Promise<string>;
};

type EnvSecretValue = string | SecretsStoreBinding;

/** Body of messages on `otel-span-insert` queue (R2 payload pointer). */
export interface OtelSpanInsertQueueMessage {
  project_id: string;
  requested_at: string;
  payload_key: string;
  payload_format: string;
  version: number;
}

export interface Env {
  INFISICAL_CLIENT_ID: EnvSecretValue;
  INFISICAL_CLIENT_SECRET: EnvSecretValue;
  INFISICAL_PROJECT_ID: EnvSecretValue;
  INFISICAL_ENVIRONMENT?: EnvSecretValue;
  INFISICAL_SECRET_PATH?: string;
  INFISICAL_SITE_URL?: string;
  INFISICAL_CACHE_TTL_SECONDS?: string;
  OTEL_PAYLOAD_KEY_PREFIX?: string;
  OTEL_PAYLOAD_TTL_SECONDS?: string;
  OTEL_WORKER_AUTH_TOKEN?: string;
  WORKER_SHARED_SECRET?: EnvSecretValue;
  /**
   * Local-dev bypass flag. When set to "true", `handleOtlpV1Traces` skips R2 + queue and
   * dispatches the gzipped payload synchronously to core via the CORE service binding,
   * because `wrangler dev` queue/R2 simulators are isolated per-process. Production
   * (where queue + R2 are real shared resources) leaves this unset.
   */
  OTLP_DEV_INLINE_DISPATCH?: string;
  OTEL_SPAN_INSERT_QUEUE: Queue<OtelSpanInsertQueueMessage>;
  /** Dead-letter queue producer (manual replay / same pointer shape). */
  OTEL_SPAN_INSERT_DLQ: Queue<OtelSpanInsertQueueMessage>;
  OTEL_BUCKET: R2Bucket;
  CORE: Fetcher;
}

const REQUIRED_ENV_KEYS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_PROJECT_ID",
  "WORKER_SHARED_SECRET",
] as const;

const INFISICAL_REQUIRED_ENV_KEYS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_PROJECT_ID",
] as const;

const DEFAULT_INFISICAL_CACHE_TTL_SECONDS = 300;
const INFISICAL_CACHE_BASE_URL = "https://otlp.infisical-cache.local";
const INFISICAL_CACHE_NAME = "otlp-infisical-secrets";

let resolvedEnvPromise: Promise<Env> | null = null;
let infisicalSecretsPromise: Promise<Record<string, string>> | null = null;
let inMemoryInfisicalSecretsCache: {
  key: string;
  secrets: Record<string, string>;
  expiresAtMs: number;
} | null = null;

function getMissingRequiredKeys(env: Env): string[] {
  return REQUIRED_ENV_KEYS.filter((key) => {
    const value = env[key];
    if (value === undefined || value === null) return true;
    if (typeof value === "string") return value.trim().length === 0;
    return false;
  });
}

function isSecretsStoreBinding(value: unknown): value is SecretsStoreBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

async function resolveEnvSecretValue(
  value: EnvSecretValue | undefined,
): Promise<string | undefined> {
  if (typeof value === "string") {
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

function toSecretEntries(
  rawSecrets: unknown,
): Array<{ key: string; value: string }> {
  const maybeList = Array.isArray(rawSecrets)
    ? rawSecrets
    : Array.isArray((rawSecrets as { secrets?: unknown[] } | null)?.secrets)
      ? ((rawSecrets as { secrets: unknown[] }).secrets ?? [])
      : [];

  return maybeList
    .map((secret) => {
      const typed = secret as Record<string, unknown>;
      const key = typed.secretKey ?? typed.secretName ?? typed.key;
      const value = typed.secretValue ?? typed.value;
      if (typeof key !== "string" || typeof value !== "string") {
        return null;
      }
      return { key, value };
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null);
}

function getInfisicalCacheTtlSeconds(env: Env): number {
  const raw = Number(
    env.INFISICAL_CACHE_TTL_SECONDS ?? DEFAULT_INFISICAL_CACHE_TTL_SECONDS,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_INFISICAL_CACHE_TTL_SECONDS;
  }
  return Math.trunc(raw);
}

function getInfisicalCacheKey(
  env: Env & {
    INFISICAL_PROJECT_ID: string;
    INFISICAL_ENVIRONMENT: string;
  },
): string {
  return JSON.stringify({
    projectId: env.INFISICAL_PROJECT_ID,
    environment: env.INFISICAL_ENVIRONMENT,
    secretPath: env.INFISICAL_SECRET_PATH ?? "/",
    siteUrl: env.INFISICAL_SITE_URL ?? "",
  });
}

function buildInfisicalCacheRequest(cacheKey: string): Request {
  const key = encodeURIComponent(cacheKey);
  return new Request(`${INFISICAL_CACHE_BASE_URL}/v1/secrets?key=${key}`, {
    method: "GET",
  });
}

async function getCachedInfisicalSecrets(
  cacheKey: string,
  ttlSeconds: number,
): Promise<Record<string, string> | null> {
  const now = Date.now();
  if (
    inMemoryInfisicalSecretsCache &&
    inMemoryInfisicalSecretsCache.key === cacheKey &&
    inMemoryInfisicalSecretsCache.expiresAtMs > now
  ) {
    return inMemoryInfisicalSecretsCache.secrets;
  }

  try {
    const cache = await caches.open(INFISICAL_CACHE_NAME);
    const cacheRequest = buildInfisicalCacheRequest(cacheKey);
    const cachedResponse = await cache.match(cacheRequest);
    if (!cachedResponse) return null;
    const payload = (await cachedResponse.json()) as { secrets?: unknown };
    const secrets = payload.secrets;
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
      return null;
    }
    const typedSecrets = secrets as Record<string, string>;
    inMemoryInfisicalSecretsCache = {
      key: cacheKey,
      secrets: typedSecrets,
      expiresAtMs: now + ttlSeconds * 1000,
    };
    return typedSecrets;
  } catch {
    return null;
  }
}

async function storeCachedInfisicalSecrets(
  cacheKey: string,
  ttlSeconds: number,
  secrets: Record<string, string>,
): Promise<void> {
  const now = Date.now();
  inMemoryInfisicalSecretsCache = {
    key: cacheKey,
    secrets,
    expiresAtMs: now + ttlSeconds * 1000,
  };

  try {
    const cache = await caches.open(INFISICAL_CACHE_NAME);
    const cacheRequest = buildInfisicalCacheRequest(cacheKey);
    const cacheResponse = new Response(JSON.stringify({ secrets }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttlSeconds}`,
      },
    });
    await cache.put(cacheRequest, cacheResponse);
  } catch {
    // Best-effort cache write only.
  }
}

async function fetchAndCacheInfisicalSecrets(
  env: Env & {
    INFISICAL_CLIENT_ID: string;
    INFISICAL_CLIENT_SECRET: string;
    INFISICAL_PROJECT_ID: string;
    INFISICAL_ENVIRONMENT: string;
  },
  cacheKey: string,
  ttlSeconds: number,
): Promise<Record<string, string>> {
  const client = new InfisicalSDK({
    ...(env.INFISICAL_SITE_URL ? { siteUrl: env.INFISICAL_SITE_URL } : {}),
  });

  let secretsResponse: unknown;
  try {
    await client.auth().universalAuth.login({
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
    });

    secretsResponse = await client.secrets().listSecretsWithImports({
      environment: env.INFISICAL_ENVIRONMENT,
      projectId: env.INFISICAL_PROJECT_ID,
      secretPath: env.INFISICAL_SECRET_PATH ?? "/",
      expandSecretReferences: true,
      viewSecretValue: true,
      recursive: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Infisical auth failed (check INFISICAL_CLIENT_ID/CLIENT_SECRET/PROJECT_ID/ENVIRONMENT): ${detail}`,
    );
  }

  const entries = toSecretEntries(secretsResponse);
  const secrets = Object.fromEntries(
    entries.map((entry) => [entry.key, entry.value]),
  );
  await storeCachedInfisicalSecrets(cacheKey, ttlSeconds, secrets);
  return secrets;
}

async function fetchInfisicalSecrets(
  env: Env & {
    INFISICAL_CLIENT_ID: string;
    INFISICAL_CLIENT_SECRET: string;
    INFISICAL_PROJECT_ID: string;
    INFISICAL_ENVIRONMENT: string;
  },
): Promise<Record<string, string>> {
  const cacheKey = getInfisicalCacheKey(env);
  const ttlSeconds = getInfisicalCacheTtlSeconds(env);
  const cachedSecrets = await getCachedInfisicalSecrets(cacheKey, ttlSeconds);
  if (cachedSecrets) {
    return cachedSecrets;
  }

  if (infisicalSecretsPromise) {
    return infisicalSecretsPromise;
  }

  const pendingFetch = fetchAndCacheInfisicalSecrets(env, cacheKey, ttlSeconds);
  pendingFetch.finally(() => {
    if (infisicalSecretsPromise === pendingFetch) {
      infisicalSecretsPromise = null;
    }
  });
  infisicalSecretsPromise = pendingFetch;
  return pendingFetch;
}

async function resolveAndValidateEnv(env: Env): Promise<Env> {
  const infisicalClientId = await resolveEnvSecretValue(
    env.INFISICAL_CLIENT_ID,
  );
  const infisicalClientSecret = await resolveEnvSecretValue(
    env.INFISICAL_CLIENT_SECRET,
  );
  const infisicalProjectId = await resolveEnvSecretValue(
    env.INFISICAL_PROJECT_ID,
  );
  const workerSharedSecret = await resolveEnvSecretValue(
    env.WORKER_SHARED_SECRET,
  );
  const infisicalEnvironment =
    (await resolveEnvSecretValue(env.INFISICAL_ENVIRONMENT)) ?? "dev";
  const normalizedEnv = {
    ...env,
    INFISICAL_CLIENT_ID: infisicalClientId ?? "",
    INFISICAL_CLIENT_SECRET: infisicalClientSecret ?? "",
    INFISICAL_PROJECT_ID: infisicalProjectId ?? "",
    INFISICAL_ENVIRONMENT: infisicalEnvironment,
    WORKER_SHARED_SECRET: workerSharedSecret ?? "",
  } as Env;

  const missingBefore = getMissingRequiredKeys(normalizedEnv);
  const missingInfisical = missingBefore.filter(
    (key): key is (typeof INFISICAL_REQUIRED_ENV_KEYS)[number] =>
      (INFISICAL_REQUIRED_ENV_KEYS as readonly string[]).includes(key),
  );
  if (missingInfisical.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingInfisical.join(", ")}`,
    );
  }

  if (missingBefore.length === 0) {
    return normalizedEnv;
  }

  const infisicalSecrets = await fetchInfisicalSecrets(
    normalizedEnv as Env & {
      INFISICAL_CLIENT_ID: string;
      INFISICAL_CLIENT_SECRET: string;
      INFISICAL_PROJECT_ID: string;
      INFISICAL_ENVIRONMENT: string;
    },
  );
  const envRecord = normalizedEnv as unknown as Record<
    string,
    string | undefined
  >;
  const resolved = {
    ...normalizedEnv,
    ...Object.fromEntries(
      Object.entries(infisicalSecrets).filter(([key]) => !envRecord[key]),
    ),
  } as Env;

  const missingAfter = getMissingRequiredKeys(resolved);
  if (missingAfter.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingAfter.join(", ")}`,
    );
  }

  return resolved;
}

export async function resolveEnv(env: Env): Promise<Env> {
  const hasUnresolvedRequiredBinding = REQUIRED_ENV_KEYS.some((key) =>
    isSecretsStoreBinding(env[key]),
  );
  if (getMissingRequiredKeys(env).length === 0 && !hasUnresolvedRequiredBinding) {
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
  return env.OTEL_PAYLOAD_KEY_PREFIX?.trim() || "otel:payload:v1";
}
