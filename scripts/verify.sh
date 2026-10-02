#!/usr/bin/env bash
# Тонкий wrapper над ~/.claude/templates/verify-core.sh для appmetrica-mcp (npm/tsc).
export PROJECT_TYPE=npm
export NPM_BUILD=build
export RUN_TESTS=0
export RUN_LINT=0
cd "$(dirname "$0")/.." || exit 1
exec ~/.claude/templates/verify-core.sh "$@"
