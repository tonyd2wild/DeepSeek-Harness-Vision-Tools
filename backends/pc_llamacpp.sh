#!/usr/bin/env bash
# Windows / Linux / NVIDIA "eyes" server via llama.cpp.
# Downloads the vision model GGUF + its vision projector (mmproj) and serves an
# OpenAI-compatible vision endpoint on :8081.
#
# Requires llama.cpp's `llama-server` on PATH:
#   Linux/Mac : brew install llama.cpp   (or build w/ CUDA: https://github.com/ggml-org/llama.cpp)
#   Windows   : winget install llama.cpp (or a CUDA build from the releases page)
set -euo pipefail
PORT="${PORT:-8081}"
REPO="${REPO:-unsloth/Qwen3.5-0.8B-GGUF}"
QUANT="${QUANT:-UD-Q4_K_XL}"        # text-model quant; see MODELS.md for smaller/bigger options
MMPROJ="${MMPROJ:-mmproj-F16.gguf}" # the vision projector, WITHOUT this it runs text-only
NGL="${NGL:-99}"                    # layers to offload to GPU; NGL=0 = CPU only

if ! command -v llama-server >/dev/null 2>&1; then
  echo "[pc] ERROR: llama-server not found on PATH."
  echo "[pc]   Linux/Mac : brew install llama.cpp"
  echo "[pc]   Windows   : winget install llama.cpp   (use a CUDA build for GPU)"
  echo "[pc]   Source    : https://github.com/ggml-org/llama.cpp"
  exit 1
fi

echo "[pc] starting llama-server on :$PORT"
echo "[pc]   model  : ${REPO}:${QUANT}"
echo "[pc]   mmproj : ${REPO}/${MMPROJ}   (vision, required for image input)"
echo "[pc]   ngl    : ${NGL}"
echo "[pc]   NOTE   : keep EYES_MODEL in .env matching what this serves"
echo "[pc] endpoint : http://localhost:$PORT/v1"

# -hf auto-downloads the GGUF + mmproj from Hugging Face on first run.
exec llama-server \
  -hf "${REPO}:${QUANT}" \
  --mmproj "${REPO}/${MMPROJ}" \
  -ngl "$NGL" \
  --host 0.0.0.0 --port "$PORT" \
  --temp 0.6 --top-p 0.95 --top-k 20
