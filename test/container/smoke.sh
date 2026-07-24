#!/usr/bin/env bash
set -euo pipefail

name_image="${1:-langfuse-backup:test}"

docker run --rm "${name_image}" --help | grep -q "langfuse-backup"
docker run --rm --entrypoint pg_dump "${name_image}" --version | grep -q "17"
docker run --rm --entrypoint pg_restore "${name_image}" --version | grep -q "17"

id_runtime="$(docker run --rm --entrypoint id "${name_image}" -u)"
test "${id_runtime}" != "0"
