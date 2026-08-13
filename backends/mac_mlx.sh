#!/usr/bin/env bash
# Apple Silicon "eyes" server via MLX (mlx-vlm).
# Serves an OpenAI-compatible vision endpoint on :8081. The client (the shim)
# sends the model id per request, so keep EYES_MODEL in .env matching this.
# The model auto-downloads from the HF cache on first request.
set -euo pipefail
PORT="${PORT:-8081}"

if ! command -v mlx_vlm.server >/dev/null 2>&1; then
  echo "[mac] mlx-vlm not found. Install it into a venv or user site (never system python):"
  echo "[mac]   python3 -m venv ~/.venvs/eyes && source ~/.venvs/eyes/bin/activate"
  echo "[mac]   pip install -U mlx-vlm"
  echo "[mac] then re-run this script."
  exit 1
fi

echo "[mac] starting mlx_vlm.server on :$PORT"
echo "[mac] default eyes model: mlx-community/Qwen3.5-0.8B-MLX-8bit (~1 GB, ~2-3 GB RAM)"
echo "[mac]   set a different one via EYES_MODEL in .env (it is sent per-request)"
echo "[mac] endpoint: http://localhost:$PORT/v1"
exec mlx_vlm.server --port "$PORT" --host 0.0.0.0
