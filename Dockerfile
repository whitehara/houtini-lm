# syntax=docker/dockerfile:1
#
# Three-stage build. All stages share node:22-bookworm-slim (not alpine) for two
# reasons: package.json declares engines.node >=22.5.0, and src/model-cache.ts
# dynamically imports node:sqlite — a Node 22.5+ builtin whose native binding
# behaviour is best verified against a glibc runtime rather than musl.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force
COPY --from=build /app/dist ./dist

# src/version.ts reads package.json at runtime via
# new URL('../package.json', import.meta.url) relative to dist/index.js, so it
# must exist one level above dist/ — the npm ci above already placed it here.

# inference-lock.ts and model-cache.ts both resolve their state directory from
# os.homedir(); pin HOME explicitly so that resolves predictably in a
# container rather than depending on the base image's passwd defaults.
ENV HOME=/home/node

# Neither module creates its state directory until it's actually needed
# (mkdirSync at first use), so it doesn't exist in the image yet. Create it
# now, owned by node:node, so a named volume mounted here on first run
# inherits this ownership instead of the root:root a Docker-created mount
# point would otherwise get — without this, inference.lock/model-cache.db
# writes fail with EACCES under the non-root USER below.
RUN mkdir -p /home/node/.houtini-lm && chown -R node:node /home/node

USER node

ENTRYPOINT ["node", "dist/index.js"]
