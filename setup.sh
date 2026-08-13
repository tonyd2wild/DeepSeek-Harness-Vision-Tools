#!/usr/bin/env bash
# Bring up a LOCAL vision server (the "eyes") and PROVE it serves. Both doors use
# it: the proxy (chat attachments) and the analyze_image tool (files on disk).
#
#   DOOR 1  dsh --> :8900 proxy ─┬─ image? ──► vision server ──► "[Image: ...]"
#                                └─ text ─────► your text model ──► streamed back
#   DOOR 2  dsh --> analyze_image tool ──► vision server ──► "[Image: ...]"
#
# Set RUN_PROXY=1 to also start the proxy here. Deliberately does NOT deploy your
# text (brain) model; vision attaches alongside whatever you already run.
set -uo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; . ./.env; set +a; }
VISION_PORT="${VISION_PORT:-8081}"
RUN_PROXY="${RUN_PROXY:-0}"
SHIM_PORT="${SHIM_PORT:-8900}"
VISION_TARGET="${VISION_TARGET:-http://127.0.0.1:8000}"

say(){ printf "\033[1m%s\033[0m\n" "$*"; }
ok(){  printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$*"; }

# --------------------------------------------------------- 1  vision server
say "1  Checking the local vision server on :$VISION_PORT (the eyes)"
if curl -s -m 5 "http://127.0.0.1:$VISION_PORT/v1/models" | grep -q '"id"'; then
  ok "already up"
else
  echo "     not up, starting one for this platform..."
  OS="$(uname -s)"; ARCH="$(uname -m)"
  if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
    echo "     → Apple Silicon: MLX backend (backends/mac_mlx.sh)"
    PORT="$VISION_PORT" nohup bash backends/mac_mlx.sh >/tmp/vision-eyes.log 2>&1 & disown
  elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    echo "     → NVIDIA GPU: llama.cpp backend (backends/pc_llamacpp.sh)"
    PORT="$VISION_PORT" nohup bash backends/pc_llamacpp.sh >/tmp/vision-eyes.log 2>&1 & disown
  else
    echo "     → No NVIDIA GPU: llama.cpp CPU backend (works, just slower)"
    PORT="$VISION_PORT" NGL=0 nohup bash backends/pc_llamacpp.sh >/tmp/vision-eyes.log 2>&1 & disown
  fi
  for i in $(seq 1 40); do
    sleep 3
    curl -s -m 4 "http://127.0.0.1:$VISION_PORT/v1/models" | grep -q '"id"' && { ok "up after ~$((i*3))s"; break; }
    if [ "$i" = 40 ]; then
      bad "vision server did not come up, see /tmp/vision-eyes.log"
      echo "     Mac:   pip install -U mlx-vlm   (in a venv, never system python)"
      echo "     PC:    install llama.cpp so 'llama-server' is on PATH"
      echo "     ⚠️  llama.cpp needs the mmproj projector or the model cannot see"
      exit 1
    fi
  done
fi

MODELS=$(curl -s -m 5 "http://127.0.0.1:$VISION_PORT/v1/models" 2>/dev/null)
SERVED=$(echo "$MODELS" | python3 -c "import sys,json;print(' '.join(m['id'] for m in json.load(sys.stdin).get('data',[])[:4]))" 2>/dev/null)
[ -n "$SERVED" ] && ok "serving: $SERVED"

# --------------------------------------------------------- 2  optional proxy
if [ "$RUN_PROXY" = "1" ]; then
  say "2  Starting the vision proxy on :$SHIM_PORT (door 1, chat attachments)"
  echo "     proxy forwards to your text model at $VISION_TARGET"
  if ! curl -s -m 10 "$VISION_TARGET/v1/models" | grep -q '"id"'; then
    bad "no text model answering at $VISION_TARGET"
    echo "     Set VISION_TARGET in .env to YOUR text model's OpenAI-compatible endpoint."
    echo "     (A running container is not a serving model; only /v1/models counts.)"
    exit 1
  fi
  pkill -f "[v]ision_shim.py" 2>/dev/null; sleep 1
  nohup python3 shim/vision_shim.py >/tmp/vision-proxy.log 2>&1 & disown
  sleep 3
  H=$(curl -s -m 25 "http://127.0.0.1:$SHIM_PORT/health")
  if echo "$H" | grep -q '"ready": true'; then
    ok "proxy ready (both legs serving)"
  else
    bad "proxy not ready"; echo "$H"; exit 1
  fi
fi

# --------------------------------------------------------- next steps
echo
say "Vision server ready on :$VISION_PORT."
echo "  health:  curl http://127.0.0.1:$VISION_PORT/v1/models"
echo "  logs:    tail -f /tmp/vision-eyes.log"
echo
say "DOOR 1: the proxy (chat attachments):"
if [ "$RUN_PROXY" = "1" ]; then
  echo "  up on :$SHIM_PORT. Point a dsh route's baseURL at http://127.0.0.1:$SHIM_PORT/v1"
  echo "  and declare input:[text,image]. Keep a no-proxy fallback route. See examples/dsh.md."
  echo "  logs:  tail -f /tmp/vision-proxy.log   ·   autostart: autostart/"
else
  echo "  re-run with RUN_PROXY=1, or:  python3 shim/vision_shim.py --port $SHIM_PORT \\"
  echo "     --upstream $VISION_TARGET --vision-url http://127.0.0.1:$VISION_PORT/v1/chat/completions --vision-model <id>"
fi
echo
say "DOOR 2: the analyze_image tool (files on disk):"
echo "  1. point VISION_FAST_URL at  http://127.0.0.1:$VISION_PORT/v1/chat/completions"
echo "  2. cp -r plugin/vision ~/.dsh/plugins/vision   (then fix its dsh-tools link)"
echo "  3. dsh plugin --profile <p> add link:~/.dsh/plugins/vision"
echo "  4. make it the default via an upgrade-safe user preset"
echo
say "Then tell the agent it is not multimodal:  cp examples/AGENTS.md \$DSH_HOME/AGENTS.md"
echo "  full walkthrough:  examples/dsh.md"
