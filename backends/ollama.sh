#!/usr/bin/env bash
# Optional "eyes" server via Ollama, the easiest path if you want a one-liner
# and don't mind a different model than the Qwen3.5 default.
#
# Ollama does NOT support Qwen3.5 vision yet (it can't load the standalone
# mmproj vision projector), so this path uses Moondream or Qwen2.5-VL instead.
# For Qwen3.5, use backends/pc_llamacpp.sh or backends/mac_mlx.sh.
#
# Ollama serves an OpenAI-compatible endpoint at :11434/v1. After this runs,
# point the shim at it in .env:
#   EYES_URL=http://127.0.0.1:11434/v1/chat/completions
#   EYES_MODEL=moondream           # or qwen2.5vl:3b
set -euo pipefail
MODEL="${OLLAMA_MODEL:-moondream}"   # moondream (~1.9B) or qwen2.5vl:3b

if ! command -v ollama >/dev/null 2>&1; then
  echo "[ollama] ERROR: ollama not found on PATH."
  echo "[ollama]   Install: https://ollama.com/download"
  exit 1
fi

echo "[ollama] pulling vision model: $MODEL"
ollama pull "$MODEL"

echo "[ollama] ensuring the server is running (OpenAI-compatible on :11434/v1) ..."
# `ollama serve` is usually already running as a background service; start it if not.
if ! curl -s -m 3 http://127.0.0.1:11434/v1/models >/dev/null 2>&1; then
  nohup ollama serve >/tmp/ollama.log 2>&1 &
  disown
  sleep 2
fi

echo "[ollama] ready. Set these in .env, then run ./setup.sh (or restart the shim):"
echo "[ollama]   EYES_URL=http://127.0.0.1:11434/v1/chat/completions"
echo "[ollama]   EYES_MODEL=$MODEL"
