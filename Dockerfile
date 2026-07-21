# piweb web tier.
#
# This image runs ONLY the web server — no pi binary, no host access. The pi
# worker runs on the host (see deploy/piweb-worker.service) so the agent keeps
# systemctl/docker/GPU/project access; the two halves meet solely in the shared
# SQLite database on a bind mount.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 is native; give it a toolchain in case no prebuilt binary
# matches this platform. Only the build stage pays for it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we ship.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

# Least privilege: the web tier only ever needs to read/write the shared data
# directory, which is bind-mounted with matching ownership.
USER node

EXPOSE 8099

CMD ["node", "dist/cli/piweb.js", "web"]
