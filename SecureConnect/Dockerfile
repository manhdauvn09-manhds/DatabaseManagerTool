# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

# ---------- builder: run tests then build ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Gate the build on tests. Build fails fast if any unit test fails.
RUN npm run test
RUN npm run build

# ---------- runner: minimal production image ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Entrypoint that strips a BOM from the runtime env file before loading it.
COPY --from=builder --chown=nextjs:nodejs /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Persistent data dir for saved-connection profiles (mounted via volume in compose).
# Pre-create so the named volume inherits ownership on first mount.
RUN mkdir -p /data && chown nextjs:nodejs /data

USER nextjs
EXPOSE 3000

# wget without --spider so it issues GET (not HEAD). Next.js app router only
# exports GET for /api/health; HEAD would return 405 and flip the container
# to (unhealthy) even though the app is fine.
#
# Read the BODY, do not discard it. `-O /dev/null` only ever proved that some
# bytes arrived with status 200, which is how a dead API stayed "healthy" for
# months: an error page, an empty body or a JSON error all pass a status check.
#
# Honest limit: this still cannot catch a lying Content-Encoding header, because
# wget sends no Accept-Encoding and ignores the header. Only a real browser
# decompresses — that check lives in the Playwright smoke suite (e2e/smoke.spec.ts).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O - --tries=1 http://127.0.0.1:3000/api/health | grep -q '"ok":true' || exit 1

CMD ["sh", "./docker-entrypoint.sh"]
