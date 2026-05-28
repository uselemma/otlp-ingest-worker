# Lemma OTLP Worker

Standalone Cloudflare Worker for OTLP HTTP trace ingest (`POST /otel/v1/traces`), R2 gzip storage, and **`otel-span-insert`** queue production. The public API worker validates bearer auth before forwarding via service binding; **`core`** consumes the queue for database inserts and process-trace workflows.

Maintained as its own repository with no code dependency on other Lemma app repos.

## Commands

```bash
npm install
npm run type-check
npm run test
npm run dev       # local wrangler (see wrangler.local.toml)
npm run deploy    # production
```

(`pnpm` works too if you prefer; this repo vendors a `package-lock.json` for `npm`.)

Copy `.dev.vars.example` to `.dev.vars` for local secrets (never commit `.dev.vars`).

## Git

If `git init` was not run locally:

```bash
git init
```
