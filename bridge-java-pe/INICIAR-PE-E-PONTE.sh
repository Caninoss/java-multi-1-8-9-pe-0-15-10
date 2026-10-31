#!/usr/bin/env bash
set -eo pipefail
SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$(dirname -- "$SCRIPT_DIR")/INICIAR-PE-E-PONTE.sh"