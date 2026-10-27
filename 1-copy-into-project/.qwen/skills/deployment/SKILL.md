---
name: deployment
description: Production build, env variables, Docker, CI and migrations. Use when deploying, hosting or containerizing the app, or adding CI.
---

# Deploying and CI

Ask the user where the app will run (Vercel, a VPS or Docker host, a cloud platform) before writing platform files; each one has its own setup. The installed docs are `node_modules/next/dist/docs/01-app/01-getting-started/17-deploying.md` and `02-guides/environment-variables.md`.

## 1. Production build

- `npm run build`, then `npm run start` runs the production server; it supports every Next.js feature. Test the production build locally before deploying: it fails on things `next dev` lets through.
- Static export (`output: "export"`) only works when nothing needs a server: no route handlers that read requests, no Server Actions, no request-time data.

## 2. Environment variables

- **`NEXT_PUBLIC_` values are inlined into the JavaScript at `next build`.** After the build they no longer change: a Docker image built once and run in staging and production keeps the build's values. Set them right at build time, or serve them from your own endpoint.
- **Server-only variables** (no prefix) are read when the code runs, so one image can run in several environments with different values, as long as they're read at request time (the docs use `await connection()` before reading `process.env` in a page).
- Production secrets live in the host's settings or secret store, never in the image, the repo or the CI log. Keep a `.env.example` listing every variable the app needs, without values.
- Check required server variables in one env module, inside a function (`getEnv()`, which checks on first call and remembers the result), not at the top level of the file: `next build` imports server modules to prerender pages, and a top-level check fails the build wherever production secrets aren't present (a Docker build, CI). A missing variable then shows up as a clear error on the first request that needs it; a health check that calls `getEnv()` catches it right after deploy.

## 3. Docker (self-hosting)

Set `output: "standalone"` in `next.config.ts`: `next build` then writes `.next/standalone` with a minimal `server.js` and only the `node_modules` it needs. It doesn't copy `public` or `.next/static`, so the image copies them:

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_ values are baked in here, at build time: one ARG + ENV pair per variable, and
# `docker build --build-arg NEXT_PUBLIC_SITE_URL=https://example.com .` (an unknown build arg is ignored).
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

- Match `NODE_VERSION` to the Node the project uses (`engines` in `package.json`, `.nvmrc`, or `node -v`).
- Add a `.dockerignore` with at least `node_modules`, `.next`, `.git`, `.env*` and `test-results`, so secrets and local builds don't end up in the image.
- `HOSTNAME=0.0.0.0` makes the server reachable from outside the container.
- On Windows, building standalone output outside Docker can need Developer Mode for symlinks (the `output` docs); inside the Linux build stage it doesn't.

Build it and run it once (`docker build -t app . && docker run --rm -p 3000:3000 --env-file .env app`) before calling the setup done.

## 4. CI: run the checks on every push

The same checks the kit runs before "done" (the session start message names them), plus the browser tests:

```yaml
# .github/workflows/checks.yml
name: checks
on: [push, pull_request]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx next typegen && npx tsc --noEmit && npm run lint && npm test
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
```

Replace the check line with the project's own command, and leave out steps for things the project doesn't have (no `test` script, no Playwright). Check the action versions against their release pages; they move on.

## 5. Running it

- **Health check:** a cheap route (`app/api/health/route.ts` returning `Response.json({ ok: true })`) for the host or load balancer to poll. Don't make it touch the database on every call unless that's what you want to monitor.
- **Database migrations run once per deploy, before the new version takes traffic** (a release step or a one-off job; `npx prisma migrate deploy` for Prisma), not on every server start, and never `migrate dev` or `db push` against production.
- **Changes that the old and new versions both survive:** add a column first and start using it, remove the old one in a later deploy. Renaming or dropping in the same deploy breaks the version still running.
- **Logs and errors:** send the server's output somewhere you can search, and set up error reporting (the `errors-and-logging` skill).

## Before you finish

Say what you ran (a production build, the Docker image, the CI workflow on a push) and what you could not run here, such as the actual host.
