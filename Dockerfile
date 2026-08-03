# syntax=docker/dockerfile:1.6
#
# Cardo production image. Three-stage (deps / builder / runner) standalone
# Next.js build. Consumes the public @rome-protocol/registry github: dep via
# anonymous `npm ci` — no token, no credentials — so a fork PR build reaches
# nothing privileged. NEXT_PUBLIC_* is inlined at build; runtime chain/RPC
# config is read server-side via /api/env + /api/rpc, so one image runs
# against any deploy.

# --- deps: install dependencies (cached separately from the source copy) ---
# node:25 is REQUIRED, not a preference: the lockfile is npm-11-shaped, and
# npm 10 (node 22) rejects `npm ci` as out-of-sync. Matches pr-validate.yml's
# node pin — bump the two in lockstep.
FROM node:25-alpine AS deps
# git: the @rome-protocol/registry dep is a github: reference, fetched at
# install time. Native build chain (python3/make/g++ + eudev-dev/linux-headers
# /libusb-dev) is for the addon deps that lack alpine prebuilts — chiefly the
# @ledgerhq hw-transport HID stack pulled in by the wallet adapters. Stripped
# from the runtime image.
RUN apk add --no-cache libc6-compat git python3 make g++ eudev-dev linux-headers libusb-dev pkgconf
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: produce the standalone Next.js bundle ---
FROM node:25-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build regenerates lib/chain-config.generated.json from the installed registry
# pin (build:chain-config) + solana program metadata (build:solana-programs)
# before next build. All read the installed npm dep, no network.
RUN npm run build

# --- runner: minimal production runtime ---
FROM node:25-alpine AS runner
# tini reaps zombies when next forks workers. Strip npm from the runtime — the
# entrypoint is `node server.js` and npm only adds transitive SBOM surface.
RUN apk add --no-cache libc6-compat tini \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
