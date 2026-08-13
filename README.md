# 👁️ DeepSeek Harness Vision Tools

> ### ⚠️ Unofficial community project
>
> **Not affiliated with, endorsed by, or maintained by DeepSeek AI.** This is a
> third-party add-on for their open-source harness. For the official project see
> [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
> Please do not report issues with this repo to DeepSeek.

**Give your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
eyes: keep your text model as the brain, and let a local vision model do the
*seeing*. Any text model, any vision model, on Mac or Windows/PC.**

The model driving `dsh` is usually **text-only** (DeepSeek, dense Qwen, Llama,
Mistral). Hand it an image and `dsh` refuses before it sends, naming the model.
Declaring `input: [text, image]` to force it through is worse: the endpoint then
answers `400 "not a multimodal model"` mid-turn, after the message is already
durable, and the session retries forever.

So there are **two doors an image can come through, and this repo ships a
mechanism for each.** They are complementary, not primary-and-alternative.

| entry point | mechanism |
|---|---|
| **image attached in chat** | the **vision proxy** (automatic, intercepts before the model) |
| **image file on disk** | the **`analyze_image` tool** (the agent chooses when to look) |

**Why both.** The tool cannot serve a chat attachment: for the model to *decide*
to call a vision tool, the image must first reach the model, which is the exact
request `dsh` refuses. Only a proxy that rewrites the image **before it reaches the
brain** can handle chat attachments. And a proxy cannot pick up a file the agent
hasn't put in a message, so the tool covers files on disk. Different doors.

```
DOOR 1  chat attachment
  composer --image--> dsh --> vision-proxy --image--> local vision model
                                   |                        |
                                   |<------ description -----|
                                   +--"[Image: ...]" as TEXT--> your brain

DOOR 2  file on disk
  DeepSeek --calls tool--> analyze_image(path, backend) --> local vision model
       ^                                                          |
       +--------------- "[Image: ...]" as TEXT -------------------+

In both, image bytes go ONLY to the vision model. The brain sees words, never
pixels, so nothing gets refused.
```

Full walkthrough for both doors, plus the pi-ai route config, the traps, and
restart rules: **[examples/dsh.md](examples/dsh.md)**.

---

## You bring both models, that's the whole point

We run a very specific DeepSeek build on very specific hardware. **Our model only
works for us.** So this recipe never hardcodes a model: you choose *both* ends.

| Slot | What you put there | Recommended default |
|---|---|---|
| **The brain** (text) | whatever `dsh` already drives, any text model | *your existing model* |
| **The eyes** (vision) | a local VLM the proxy and/or tool calls | `fast` + `detailed` (below) |

The **same eyes model** serves both doors. The tool exposes two backends, chosen
per call, and the proxy takes one via `--vision-model`:

| role | when | example model |
|---|---|---|
| `fast` *(default)* | colours, layout, coarse content | a tiny ~0.8B VLM (e.g. Qwen3.5-0.8B) |
| `detailed` | small text, fine detail | a larger VLM (e.g. a ~27B Qwen2.5-VL / Qwen3-VL build) |

Per-platform picks, memory numbers, and a full swap table: **[MODELS.md](MODELS.md)**.

---

## What you need

| | |
|---|---|
| **A text model `dsh` drives** | already running, any OpenAI-compatible model |
| **A local VLM** | the eyes; ~2–3 GB spare for the tiny `fast` one |
| **Python 3.8+** | for the proxy, stdlib only, zero dependencies |
| **`pnpm`** | only for the tool: `dsh plugin` shells out to it |
| **A vision runtime** | Mac: MLX (`mlx-vlm`) · Windows/PC: llama.cpp (or Ollama for the fallback models) |

---

## Quick start

```bash
git clone https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools
cd DeepSeek-Harness-Vision-Tools
cp .env.example .env      # point the endpoints at YOUR hosts
./setup.sh                # brings up a local vision server (+ the proxy with RUN_PROXY=1)
```

**Door 1, the proxy** (chat attachments):

```bash
python3 shim/vision_shim.py --port 8900 \
  --upstream http://127.0.0.1:8000 \
  --vision-url http://YOUR_FAST_VISION_HOST:8081/v1/chat/completions \
  --vision-model your-fast-vlm
```

Then add a `dsh` route whose `baseURL` is the proxy (`http://127.0.0.1:8900/v1`)
and that declares `input: [text, image]`. The exact pi-ai provider block, plus a
no-proxy fallback route, is in **[examples/dsh.md](examples/dsh.md)**.

**Door 2, the tool** (files on disk):

```bash
cp -r plugin/vision ~/.dsh/plugins/vision   # then fix its dsh-tools link (trap 2)
dsh plugin --profile <p> add link:~/.dsh/plugins/vision
```

---

## Tell the agent what you did

A model that suddenly "sees" will reason about *why* and get it wrong, often
announcing it was switched onto a vision-model route when it was not. `dsh` reads
**`$DSH_HOME/AGENTS.md` into every session**, which is where you set it straight:
it is not multimodal, a proxy (or the tool) turned the image into words, and it
should say "the description indicates..." not "I can see...". A copy-paste snippet
with a `<model>` placeholder is in **[examples/AGENTS.md](examples/AGENTS.md)**.

---

## Making it persist across sessions

Two independent pieces, one per door.

**Proxy (door 1): autostart on login/boot.** Ready files are in
**[autostart/](autostart/)**: a Windows logon `.vbs` and a Linux systemd unit.
Edit the paths, install, done.

**Tool (door 2): an upgrade-safe user preset as the default.** Model-facing tool
rows are disabled at the host plane; the agent preset makes the tool visible.
Editing the shipped `standard` preset would work until the next upgrade overwrites
it, so instead create a USER preset with a **distinct id** (a user preset cannot
reuse a shipped id, or it is silently shadowed) composing `web` + `analyze_image`,
then set it as the default in `settings.yaml` (hot-reloaded):

```yaml
agent-presets:
  default: standard-vision
```

Presets mount **lazily on first session**, so verify by starting a **real
session**, not by watching a clean boot. Layout and composition details are in
**[examples/dsh.md](examples/dsh.md)**.

---

## It attaches, it does not take over

**This does not redeploy your model.** DeepSeek stays the brain. The proxy is a
separate process you can kill at any time (keep a no-proxy fallback route so you
can always work when it is down), and the tool only adds a capability the agent can
call. Nothing about your model deployment changes.

---

## On DGX Spark? Put the eyes on the same box

If your text brain runs on a DGX Spark (or two, the way DeepSeek V4 Flash
typically does), you usually do **not** need a separate machine for the eyes. The
`fast` vision model is featherweight, roughly **2 to 3 GB live**, so it fits
**alongside the brain on the same Spark**. Point the proxy's `--vision-url` (or the
tool's backend) at `127.0.0.1` and the whole thing, brain and eyes, runs on one
piece of hardware. Simpler than splitting the two across boxes.

⚠️ **Check real headroom first (GB10 unified memory).** On a Spark the reported
"free" memory **overstates** what CUDA can actually use, because the GPU and CPU
share one pool. The tiny `fast` model almost always fits; a large `detailed` VLM
may not. Reserve memory for whatever you co-locate and confirm it serves before
relying on it. The DGX-Spark-specific
[ancestor repo](https://github.com/tonyd2wild/DeepSeek-v4-Flash-0731-Vision-DSpark-1M-NVFP4-KV-2x-DGX-Spark)
walks the co-located setup end to end.

---

## Honest limits

Read this part. The eyes are a **description from a separate vision model, not a
native multimodal read by your brain.**

⚠️ **A description is lossy.** The vision model looks and writes words; fine detail,
exact spatial relationships, and small objects can be lost. For precise-layout
reasoning, use a larger `detailed` model.

⚠️ **Text in images is weak on a tiny VLM.** The featherweight `fast` default trades
accuracy for size. For OCR-heavy work point the proxy or tool at a larger VLM and
accept the extra RAM and latency.

⚠️ **The brain reasons over words, not pixels.** For most agent work (what's on my
screen, what's in this photo, read me this error) that is fine. For OCR-critical or
fine-grained visual reasoning it matters; use a bigger describer.

⚠️ **`input:[text,image]` is a claim, not a check.** Only declare it on a route
whose endpoint truly accepts images (the proxy, or a real VLM). Declaring it on a
text-only model gets the image rejected mid-turn, after the message is durable.

✅ **What it's genuinely good at:** giving `dsh` situational awareness of
screenshots, photos, and camera frames **without swapping out the text model you
actually want to think with.**

---

## Configuration

**Proxy** (env, or the matching CLI flag which overrides it):

| env | flag | example | what it is |
|---|---|---|---|
| `SHIM_PORT` | `--port` | `8900` | port the proxy listens on |
| `VISION_TARGET` | `--upstream` | `http://127.0.0.1:8000` | your text-only brain |
| `EYES_URL` | `--vision-url` | `http://YOUR_FAST_VISION_HOST:8081/v1/chat/completions` | the vision endpoint |
| `EYES_MODEL` | `--vision-model` | `your-fast-vlm` | served vision model id |

**Tool** (plugin config block or env):

| env | example | what it is |
|---|---|---|
| `VISION_FAST_URL` / `VISION_FAST_MODEL` | `.../8081/...` / `your-fast-vlm` | the `fast` backend |
| `VISION_DETAILED_URL` / `VISION_DETAILED_MODEL` | `.../8010/...` / `your-detailed-vlm` | the `detailed` backend |

Full example: **[.env.example](.env.example)**.

---

## Repo layout

```
shim/vision_shim.py        the vision PROXY (door 1), stdlib-only, zero deps
plugin/vision/index.js     the analyze_image TOOL (door 2)
plugin/vision/package.json declares the dsh-tools LINK (harness copy, not npm)
examples/dsh.md            the real dsh integration guide: both doors, pi-ai config, traps
examples/AGENTS.md         copy-paste $DSH_HOME/AGENTS.md so the agent knows it isn't multimodal
autostart/vision-proxy.vbs Windows logon autostart for the proxy
autostart/vision-proxy.service Linux systemd unit for the proxy
MODELS.md                  fast vs detailed eyes models + Mac-vs-PC memory + fallback table
backends/mac_mlx.sh        Apple Silicon vision server (MLX / mlx-vlm)
backends/pc_llamacpp.sh    Windows / Linux / NVIDIA vision server (llama.cpp + mmproj)
backends/ollama.sh         optional vision server (Moondream / Qwen2.5-VL) via Ollama
setup.sh                   bring up a local vision server + prove it serves (proxy optional)
.env.example               copy to .env
```

---

## Sibling projects

Part of the same family, mix and match:

- **[DeepSeek-Harness-Web-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools)**:
  free, keyless `web_search` + `web_fetch` for `dsh`. The web sibling to this vision one.
- **[2Wild-Vision-Mode / llm-eyes](https://github.com/tonyd2wild/2Wild-Vision-Mode)**:
  the standalone "eyes as a service" project this borrows the backends and model tiers from.
- **[DeepSeek-v4-Flash-0731-Vision-DSpark-1M-NVFP4-KV-2x-DGX-Spark](https://github.com/tonyd2wild/DeepSeek-v4-Flash-0731-Vision-DSpark-1M-NVFP4-KV-2x-DGX-Spark)**:
  the DGX-Spark-specific ancestor, wired to one particular DeepSeek build.

This repo generalizes that work: **any** text model, **any** vision model, on Mac or PC.

---

## Credits

Standing on other people's work, please credit them when you reuse this:

- **[DeepSeek](https://github.com/deepseek-ai)**: the DeepSeek Harness (`dsh`) and the
  DeepSeek text models.
- **[Qwen (Alibaba)](https://github.com/QwenLM)**: Qwen3.5 and Qwen2.5-VL / Qwen3-VL vision models.
- **[ggml-org / llama.cpp](https://github.com/ggml-org/llama.cpp)**: the cross-platform
  runtime and its multimodal `--mmproj` path (the Windows/PC vision backend).
- **[ml-explore / MLX](https://github.com/ml-explore/mlx)** +
  **[Blaizzy / mlx-vlm](https://github.com/Blaizzy/mlx-vlm)**: the Apple Silicon vision path.
- **[Ollama](https://github.com/ollama/ollama)**: the one-liner path for the Moondream /
  Qwen2.5-VL fallback vision models.
- **[Unsloth](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF)**: the Qwen3.5 GGUF quants
  and the `mmproj` vision projector.

If this repo helped, star the projects above first; they did the real work.

---

MIT, see [LICENSE](LICENSE).
