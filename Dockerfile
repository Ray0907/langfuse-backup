ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG POSTGRES_IMAGE=postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394
ARG SOURCE_DATE_EPOCH=0

FROM ${NODE_IMAGE} AS build

ARG SOURCE_REVISION=unknown
ENV SOURCE_REVISION=$SOURCE_REVISION

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
	pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build \
	&& pnpm prune --prod \
	&& rm node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json

FROM ${POSTGRES_IMAGE} AS runtime

ARG SOURCE_REVISION=unknown
ARG SOURCE_DATE_EPOCH
ARG TOOL_VERSION=0.1.0

LABEL org.opencontainers.image.title="langfuse-backup" \
	org.opencontainers.image.description="Verifiable backup and restore for self-hosted Langfuse" \
	org.opencontainers.image.source="https://github.com/Ray0907/langfuse-backup" \
	org.opencontainers.image.version=$TOOL_VERSION \
	org.opencontainers.image.revision=$SOURCE_REVISION \
	org.opencontainers.image.licenses="MIT"

RUN --mount=from=build,source=/,target=/mnt/build,ro \
	groupadd --gid 10001 langfuse-backup \
	&& useradd --uid 10001 --gid 10001 --no-create-home --no-log-init \
		--shell /usr/sbin/nologin langfuse-backup \
	&& cp /mnt/build/usr/local/bin/node /usr/local/bin/node \
	&& mkdir -p /app \
	&& cp -a /mnt/build/workspace/dist /app/dist \
	&& cp -a /mnt/build/workspace/node_modules /app/node_modules \
	&& cp /mnt/build/workspace/package.json /app/package.json \
	&& chown -R 10001:10001 /app \
	&& find /app -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + \
	&& touch -d "@${SOURCE_DATE_EPOCH}" /usr/local/bin/node \
		/etc /etc/group /etc/gshadow /etc/passwd /etc/shadow \
		/etc/subgid /etc/subuid /usr/local/bin

WORKDIR /app

USER 10001:10001

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
