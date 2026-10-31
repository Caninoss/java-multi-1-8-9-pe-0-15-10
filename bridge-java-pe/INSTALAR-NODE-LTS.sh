#!/usr/bin/env bash
set -eo pipefail
unset NPM_CONFIG_PREFIX npm_config_prefix || true
NVM_DIR="$HOME/.nvm"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  if command -v curl >/dev/null 2>&1; then
    curl -o- "$NVM_INSTALL_URL" | bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$NVM_INSTALL_URL" | bash
  else
    echo "Nao encontrei curl nem wget. No Ubuntu, instale curl com: sudo apt update && sudo apt install -y curl"
    exit 1
  fi
fi

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "A instalacao do nvm nao terminou corretamente."
  exit 1
fi
export NVM_DIR
. "$NVM_DIR/nvm.sh"
nvm install --lts
nvm use --lts
node -v
npm -v
echo "Node.js instalado. Agora use o comando do painel: bash INICIAR-PE-E-PONTE.sh"
