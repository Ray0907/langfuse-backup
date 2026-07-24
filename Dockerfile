FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM postgres:17-bookworm AS runtime

COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node

RUN groupadd --gid 10001 langfuse-backup \
	&& useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin langfuse-backup

WORKDIR /app

COPY --from=build --chown=10001:10001 /workspace/dist ./dist
COPY --from=build --chown=10001:10001 /workspace/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /workspace/package.json ./package.json

USER 10001:10001

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
