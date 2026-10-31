#!/usr/bin/env bash
set -eo pipefail
unset NPM_CONFIG_PREFIX npm_config_prefix || true
export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --lts >/dev/null
fi
cd "$(dirname "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 18+ e npm sao necessarios para a ponte."
  echo "Rode: bash ./INSTALAR-NODE-LTS.sh"
  exit 1
fi
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" || {
  echo "A ponte precisa do Node.js 18 ou mais novo."
  exit 1
}
if [[ ! -d node_modules/minecraft-protocol ]]; then
  npm ci --ignore-scripts
fi
exec node index.js
