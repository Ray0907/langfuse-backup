#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
	echo "Recovery E2E requires Docker." >&2
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	echo "Recovery E2E requires a running Docker daemon." >&2
	exit 1
fi

export RUN_RECOVERY_E2E=1
corepack pnpm@11.0.0 vitest run --config vitest.e2e.config.ts
