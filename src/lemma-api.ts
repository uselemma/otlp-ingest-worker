import type { Env } from './config';

export function fetchLemmaApi(
  env: Env,
  pathAndQuery: string,
  init?: RequestInit
): Promise<Response> {
  const base =
    typeof env.LEMMA_API_URL === 'string' ? env.LEMMA_API_URL.trim() : '';

  if (env.API) {
    const target = new URL(pathAndQuery, base || 'http://api.uselemma.ai');
    target.protocol = 'http:';
    target.port = '8080';
    return env.API.fetch(new Request(target.toString(), init));
  }

  if (!base) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          detail: 'Lemma API is not configured',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )
    );
  }

  return fetch(new URL(pathAndQuery, base).toString(), init);
}
