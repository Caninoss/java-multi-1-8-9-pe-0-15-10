#!/usr/bin/env bash
set -eo pipefail
unset NPM_CONFIG_PREFIX npm_config_prefix || true

export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --lts >/dev/null
fi

SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$SCRIPT_DIR"
PE_DIR="$BASE_DIR/servidor"
BRIDGE_DIR="$BASE_DIR/bridge-java-pe"
PE_PID=""
STARTED_PE=0

cleanup() {
  if [[ "$STARTED_PE" == "1" && -n "$PE_PID" ]] && kill -0 "$PE_PID" 2>/dev/null; then
    echo "Encerrando o Genisys iniciado por este script..."
    kill -TERM "$PE_PID" 2>/dev/null || true
    wait "$PE_PID" 2>/dev/null || true
    STARTED_PE=0
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$PE_DIR/PocketMine-MP.phar" || ! -f "$PE_DIR/start.sh" ]]; then
  echo "Servidor PE nao encontrado em: $PE_DIR"
  exit 1
fi
if [[ ! -f "$BRIDGE_DIR/index.js" || ! -f "$BRIDGE_DIR/config.json" ]]; then
  echo "Ponte Java nao encontrada em: $BRIDGE_DIR"
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Esta hospedagem precisa oferecer Node.js 18+ e npm. Peça ao suporte para habilitar esses recursos."
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"; then
  echo "A ponte precisa do Node.js 18 ou mais novo."
  exit 1
fi

cd "$BRIDGE_DIR"
if [[ ! -d node_modules/minecraft-protocol ]]; then
  npm ci --ignore-scripts
fi

PHP_BIN="$PE_DIR/bin/php7/bin/php"
if [[ -f "$PHP_BIN" ]]; then
  chmod +x "$PHP_BIN" 2>/dev/null || true
  if [[ ! -x "$PHP_BIN" ]]; then
    echo "O PHP incluído não pode ser executado nesta hospedagem. Peça ao suporte para verificar o PHP 7 e as permissões dos arquivos."
    exit 1
  fi
fi
if command -v pgrep >/dev/null 2>&1 && pgrep -f '[P]ocketMine-MP.phar' >/dev/null 2>&1; then
  echo "Genisys ja esta rodando; a ponte vai reutilizar o servidor na porta 19132."
else
  PREVIOUS_LINES=0
  if [[ -f "$PE_DIR/server.log" ]]; then
    PREVIOUS_LINES=$(wc -l < "$PE_DIR/server.log" 2>/dev/null || printf '0')
  fi
  echo "Iniciando Genisys PE 0.15.10 em UDP 19132..."
  (cd "$PE_DIR" && exec bash ./start.sh) &
  PE_PID=$!
  STARTED_PE=1
  READY=0
  for _ in $(seq 1 60); do
    if ! kill -0 "$PE_PID" 2>/dev/null; then
      echo "O Genisys encerrou durante a inicializacao."
      wait "$PE_PID" || true
      exit 1
    fi
    CURRENT_LINES=$(wc -l < "$PE_DIR/server.log" 2>/dev/null || printf '0')
    if [[ "$CURRENT_LINES" -lt "$PREVIOUS_LINES" ]]; then PREVIOUS_LINES=0; fi
    if [[ "$CURRENT_LINES" -gt "$PREVIOUS_LINES" ]] && tail -n "+$((PREVIOUS_LINES + 1))" "$PE_DIR/server.log" | grep -Fq 'Done ('; then
      READY=1
      break
    fi
    sleep 1
  done
  if [[ "$READY" != "1" ]]; then
    echo "Genisys nao confirmou a inicializacao. Verifique o console."
    tail -n 40 "$PE_DIR/server.log" 2>/dev/null || true
    exit 1
  fi
fi

echo "Iniciando Java 1.8 -> PE 0.15.10 em TCP 25565..."
cd "$BRIDGE_DIR"
node index.js
