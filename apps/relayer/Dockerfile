# Build Base
FROM node:24-alpine AS build-base

ARG PNPM_VERSION=11.20.0

RUN corepack enable \
    && corepack prepare pnpm@${PNPM_VERSION} --activate

USER node
WORKDIR /home/node/app

# Build Stage
FROM build-base AS build

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./

COPY --chown=node:node \
    packages/drand-quicknet/package.json \
    packages/drand-quicknet/package.json

COPY --chown=node:node \
    packages/registry-sdk/package.json \
    packages/registry-sdk/package.json

COPY --chown=node:node \
    apps/relayer/package.json \
    apps/relayer/package.json

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

RUN pnpm build:quicknet \
    && pnpm build:registry-sdk \
    && pnpm build:relayer

RUN pnpm --filter @based-labs/drand-quicknet-relayer \
    deploy --prod /home/node/deploy

# Production Stage
FROM node:24-alpine AS prod

RUN apk add --no-cache flock \
    && mkdir -p /state \
    && chown node:node /state \
    && chmod 0700 /state

USER node
WORKDIR /home/node/app

ENV NODE_ENV=production
ENV QUICKNET_STATE_DIR=/state
ENV QUICKNET_CHECKPOINT_FILE=/state/checkpoint.json

COPY --chown=node:node \
    --from=build /home/node/deploy \
    ./

COPY --chown=node:node --chmod=0755 \
    --from=build /home/node/app/apps/relayer/scripts/relayer.sh \
    ./scripts/relayer.sh

COPY --chown=node:node \
    --from=build /home/node/app/deployments \
    /home/deployments

ENTRYPOINT ["sh", "scripts/relayer.sh"]