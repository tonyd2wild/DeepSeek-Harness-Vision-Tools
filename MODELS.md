# Models & memory: you bring both

The harness is fixed (it's the DeepSeek Harness). **The models are your call.**
There are two slots, and you choose what goes in each:

- **The brain:** your text model. Whatever `dsh` already drives: DeepSeek, Qwen,
  Llama, Mistral, anything OpenAI-compatible. Vision never changes it; the brain
  reads words, not pixels.
- **The eyes:** one or two local vision-language models (VLMs). The **same eyes
  model serves both doors**: the proxy takes one via `--vision-model`, and the
  `analyze_image` tool exposes two backends (`fast` / `detailed`).

> **Our model may only work for us.** We run a very specific DeepSeek build on
> very specific hardware. Yours will differ, so this page is *options*, not a
> mandate. Pick the eyes models that fit your box; keep the text model you run.

---

## The two roles

The `analyze_image` tool exposes both as a `backend` parameter (the agent picks
per call); the proxy uses one at a time via `--vision-model`:

| backend | role | what to run there |
|---|---|---|
| **`fast`** *(default)* | colours, layout, coarse content | a tiny (~0.8B) VLM that sits *next to* your real model on the same box |
| **`detailed`** | small text, fine detail, OCR-ish work | a larger VLM; more RAM/VRAM, better reading |

The default `fast` model is **Qwen3.5-0.8B**: small enough to run alongside your
brain, good enough to say what's in frame. For `detailed`, run any larger VLM your
box can hold, for example a **~27B Qwen2.5-VL / Qwen3-VL** build. Both are just
OpenAI-compatible endpoints the tool POSTs to; point each backend's `url` + `model`
at whatever you actually serve.

You don't have to run both. A single `fast` backend is a fine start; add
`detailed` when you hit fine-detail or text-in-image work.

---

## Recommended `fast` model per platform

| Platform | Backend runtime | Model | Served id |
|---|---|---|---|
| 🍎 **Apple Silicon Mac** | MLX (`mlx_vlm.server`) | Qwen3.5-0.8B | `mlx-community/Qwen3.5-0.8B-MLX-8bit` |
| 🪟🐧 **Windows / Linux / NVIDIA** | llama.cpp (`llama-server`) | Qwen3.5-0.8B GGUF + `mmproj-F16` | matches the served id (see below) |
| ⚡ **NVIDIA CPU-only** | llama.cpp `NGL=0` | Qwen3.5-0.8B GGUF + `mmproj-F16` | same, just slower |

> **llama.cpp needs the vision projector.** On the llama.cpp path, image input
> **requires the `--mmproj` (vision projector) file**, `backends/pc_llamacpp.sh`
> passes it automatically. Without it, llama.cpp silently runs text-only and every
> description comes back generic. This is the single most common "it runs but can't
> see" failure.

For the **`detailed`** backend, run a larger VLM with the same runtimes, MLX on a
Mac (a bigger `mlx-community` VLM), or llama.cpp / vLLM on a PC (a larger
Qwen2.5-VL / Qwen3-VL GGUF or served weights). Point `VISION_DETAILED_URL` /
`VISION_DETAILED_MODEL` at it.

---

## Memory footprint: `fast` backend, Mac vs PC

| | Mac (MLX, unified memory) | PC / Linux (llama.cpp + NVIDIA) |
|---|---|---|
| **Model** | `Qwen3.5-0.8B-MLX-8bit` | `Qwen3.5-0.8B-GGUF` (UD-Q4_K_XL) |
| **Weights on disk** | ~0.98 GB | ~0.6 GB + ~0.7 GB mmproj (vision) |
| **Live footprint** | **~2–3 GB unified RAM** | **~2 GB VRAM** (KV + vision encoder + overhead) |
| **Minimum machine** | any **8 GB** Apple Silicon Mac | any GPU with **≥4 GB VRAM** (or CPU-only: ~2–3 GB system RAM) |
| **Speed** | fast (Metal) | fast (`-ngl 99` puts it all on the GPU) |

**Bottom line:** the `fast` backend is featherweight on both. On Mac it sips ~2–3 GB
of unified memory; on a PC GPU it needs only ~2 GB of VRAM, so it fits on
essentially any modern card and leaves your text model the rest. CPU-only works
too, just slower frames. The **`detailed`** backend costs whatever your larger VLM
costs; size it to your box.

---

## Fallback / upgrade eyes models

Pick a different VLM for either backend if you want smaller, faster, or
higher-quality reads.

| Model | Size | VRAM / RAM | How to run it | Notes |
|---|---|---|---|---|
| **Qwen3.5-0.8B** (default `fast`) | 0.8B | ~2 GB | MLX (Mac) / llama.cpp (PC) | best all-round tiny; **not** on Ollama yet |
| **SmolVLM-500M** | 0.5B | ~1–2 GB | llama.cpp, `ggml-org/SmolVLM-500M-Instruct-GGUF` | lightest / fastest frames |
| **Moondream2** | ~1.9B | ~4 GB | Ollama one-liner: `ollama pull moondream` | edge-tuned; easy button |
| **Qwen2.5-VL-3B** | 3B | ~5–6 GB | Ollama: `ollama pull qwen2.5vl:3b` | good middle ground for `detailed` on a small box |
| **Qwen2.5-VL / Qwen3-VL (larger)** | 7B–32B | 8–24 GB+ | llama.cpp / vLLM / MLX | a strong `detailed` backend for real OCR/fine detail |

For llama.cpp models set `REPO`/`QUANT`/`MMPROJ` before running
`backends/pc_llamacpp.sh`. For Ollama models, run `backends/ollama.sh` and set the
backend's `url` + `model` (below).

---

## The Ollama caveat (read before you reach for it)

**Ollama does not support Qwen3.5 vision yet:** it can't load the standalone
`mmproj` vision projector, so the default `fast` model won't run there. That's
exactly why the PC path uses llama.cpp, not Ollama.

If you specifically want the Ollama one-liner, use **Moondream** or **Qwen2.5-VL**
from the table above, then point the backend at Ollama's OpenAI-compatible
endpoint:

```bash
VISION_FAST_URL=http://127.0.0.1:11434/v1/chat/completions
VISION_FAST_MODEL=moondream          # or qwen2.5vl:3b
```

`backends/ollama.sh` pulls the model and prints exactly these lines for you.

---

## Tuning knobs (llama.cpp path)

- **Bigger quant for quality** (if you have the memory): `QUANT=UD-Q8_K_XL`.
- **Smaller for tight VRAM:** `QUANT=UD-IQ2_XXS` (~338 MB), or drop to `SmolVLM-500M`.
- **CPU-only:** `NGL=0`.

## Prompt behaviour (any eyes model)

The `analyze_image` tool takes a `prompt` argument, defaulting to
`"Describe this image in detail."` The agent can override it per call, e.g.
`prompt: "List every object and any visible text."` for a screenshot or receipt.

> A bigger eyes model reads text better but costs more RAM and a bit more latency
> per image. That is what the `detailed` backend is for: keep `fast` for quick
> "what am I looking at" and switch to `detailed` when the detail matters.
