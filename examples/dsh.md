# Giving `dsh` eyes, the real integration guide

Everything here is model-agnostic and sanitized. Swap the placeholder hosts,
model ids, and env names for your own.

## The core problem

You want to run `dsh` on a strong text-only model *and* be able to drop a
screenshot into the chat. You cannot, out of the box. Two walls, one behind the
other:

1. **The composer refuses.** `dsh` checks the routed model's declared modality and
   rejects the attachment before sending, naming the model.
2. **Lying about it is worse.** Declare `input: [text, image]` on a text-only route
   and the attachment goes through, then the endpoint answers
   `400 "<model> is not a multimodal model"` **mid-turn, after the user message is
   already durable.** The session then repeats a request that can never succeed.

And you cannot solve it with a tool call alone: for the model to *decide* to call a
vision tool, the image must first reach the model, which is the exact thing that
400s. Something has to intercept the image **before** it arrives.

## Two doors, two mechanisms

This repo ships both, because they cover different entry points. Neither replaces
the other.

| entry point | mechanism |
|---|---|
| **image attached in chat** | the **vision proxy** (`shim/vision_shim.py`), automatic, intercepts before the model |
| **image file on disk** | the **`analyze_image` tool** (`plugin/vision/`), the agent chooses when to look |

---

## Door 1: the vision proxy (chat attachments)

A small local HTTP service that speaks the OpenAI API, sits in front of your
text-only brain, and rewrites images into words on the way through. The brain
receives only text and never 400s; the user just attaches an image and asks.

```
composer --image--> dsh --> vision-proxy --image--> local vision model
                                 |                        |
                                 |<------ description -----|
                                 |
                                 +--"[Image: ...]" as TEXT--> your brain
```

### 1. Run the proxy

Stdlib only, no venv, no dependencies.

```bash
python3 shim/vision_shim.py \
  --port 8900 \
  --upstream http://127.0.0.1:8000 \
  --vision-url http://YOUR_FAST_VISION_HOST:8081/v1/chat/completions \
  --vision-model your-fast-vlm

curl http://127.0.0.1:8900/health   # proves both legs with live model ids
```

Flags: `--host`, `--port`, `--upstream` (your text brain), `--vision-url` /
`--vision-model` (any OpenAI-compatible multimodal endpoint), `--verbose`. Each
also has an env equivalent (see `.env.example`). `setup.sh` can bring up a local
vision server and the proxy for you.

### 2. Point a `dsh` route at the proxy

`dsh` model routes live in `$DSH_HOME/settings.yaml` under the pi-ai provider
block. Point `baseURL` at the **proxy**, not the upstream, and declare
`input: [text, image]`:

```yaml
llm-pi-ai:
  providers:
    vision-proxy:                        # any provider id you like
      displayName: Your Text Model (via vision proxy)
      apiKeyEnv: YOUR_PLACEHOLDER_KEY_ENV # any env var holding any non-empty value
      api: openai-completions
      baseURL: http://127.0.0.1:8900/v1   # the PROXY, not the upstream
      models:
        - id: your-text-model-id
          contextWindow: 262144
          maxTokens: 32768
          input: [text, image]
```

`input: [text, image]` is **true of the proxy** even though it is false of your
brain. The route describes what it talks to, and it talks to the proxy, which
genuinely accepts images.

**Model routes hot-reload, no restart.** Save the file, pick the entry in the
model picker, and attach an image.

### 3. Keep a no-proxy fallback route

The proxy is a single point of failure. Keep a **second route pointing straight at
the upstream with no `input` declared**, so there is always a way to work when the
proxy is down:

```yaml
    text-only-direct:
      displayName: Your Text Model (direct, no vision)
      apiKeyEnv: YOUR_PLACEHOLDER_KEY_ENV
      api: openai-completions
      baseURL: http://127.0.0.1:8000/v1   # the upstream itself
      models:
        - id: your-text-model-id
          contextWindow: 262144
          maxTokens: 32768
          # no input: line -> text only, cannot be handed an image
```

### How the proxy works

- **`POST /v1/chat/completions`:** every `image_url` block in every message is
  replaced with `{"type":"text","text":"[Image: <description>]"}`. If a message's
  blocks are then all text, the content collapses to a plain string (some servers
  are fussier about block arrays than strings). Everything else forwards untouched.
- **`GET /v1/models` and other GETs pass through**, so `dsh` model discovery works.
- **Streaming is passed through byte for byte.** `dsh` streams every turn, so
  buffering the response would stall the UI until the turn ended.
- **A vision failure degrades, it does not throw.** The block becomes
  `[Image: (image could not be analyzed: ...)]`, so the turn still completes and the
  model can say it could not see. Killing the request would waste the user's whole
  message.
- **Large bodies are allowed (64 MB)**, since images are base64-inlined.

---

## Door 2: the `analyze_image` tool (files on disk)

`plugin/vision/` registers a model-facing tool: the agent calls
`analyze_image(path, backend, prompt)`, the tool POSTs the image to a local vision
model, and returns the text description. DeepSeek stays the brain. This is the
right door for files the agent already knows the path to.

### 1. Put the plugin somewhere per-profile-addable

Copy `plugin/vision/` to a stable path, e.g. `~/.dsh/plugins/vision`. Edit its
`package.json` so the `@deepseek-ai/dsh-tools` `link:` target points at your
harness's bundled copy (see **trap 2** below for why).

### 2. Add it PER PROFILE, never into the install's `node_modules`

```sh
dsh plugin --profile <p> add link:~/.dsh/plugins/vision
```

`dsh plugin` shells out to **pnpm**, which must be installed. Plugins resolve from
the **profile directory**, not the install; dropping one into the install's
`node_modules` makes **every profile crash on boot** with `ERR_MODULE_NOT_FOUND`
(trap 1).

### 3. Configure the two backends

Two roles, chosen per call. Set them in the plugin config block or via env:

| backend | role | placeholder endpoint | placeholder model |
|---|---|---|---|
| `fast` *(default)* | colours, layout, coarse content | `YOUR_FAST_VISION_HOST:8081` | `your-fast-vlm` (a tiny ~0.8B VLM) |
| `detailed` | small text, fine detail | `YOUR_DETAILED_VISION_HOST:8010` | `your-detailed-vlm` (a larger VLM) |

```bash
export VISION_FAST_URL=http://YOUR_FAST_VISION_HOST:8081/v1/chat/completions
export VISION_FAST_MODEL=your-fast-vlm
export VISION_DETAILED_URL=http://YOUR_DETAILED_VISION_HOST:8010/v1/chat/completions
export VISION_DETAILED_MODEL=your-detailed-vlm
```

The backend **names** are written into the tool description at mount time (the
model cannot read config). An **unknown backend throws and names the valid
options**, no silent fallback, so a typo can never make `detailed` quietly answer
from the tiny `fast` model.

### 4. Make it the default with an upgrade-safe USER PRESET

This is the tool's "works on every session" persistence, and it survives
`npm i -g @deepseek-ai/dsh`. On the web surface, model-facing tool rows are
disabled at the host plane; the **agent preset** is what makes a tool visible.
Editing the shipped `standard` preset would work until the next upgrade overwrites
it, so instead:

1. **Create a USER preset with a DISTINCT id** (e.g. `standard-vision`) composing
   `web` + `analyze_image`. A user preset **cannot reuse a shipped id**: roots are
   first-wins and the shipped root wins, so a user preset named `standard` is
   silently shadowed. Give it its own id.

   ```
   ~/.dsh/.agent-presets/standard-vision/
   ├── agent.cordis.yml     # composes web_fetch + analyze_image
   └── preset.yml           # display name, e.g. "Standard + Vision"
   ```

2. **Set it as the default in `settings.yaml`** (hot-reloaded, no restart):

   ```yaml
   agent-presets:
     default: standard-vision
   ```

> **Presets mount LAZILY, on first session** (trap 4). A clean boot proves nothing.
> Verify by starting a **real session**.

---

## Tell the agent what you did

A model that suddenly "sees" will reason about *why* and get it wrong, often
announcing that it was switched onto a vision model route when it was not. `dsh`
reads **`$DSH_HOME/AGENTS.md` into every session**, which is where you correct it.
Full explanation and a copy-paste snippet with a `<model>` placeholder are in
**[AGENTS.md](AGENTS.md)**.

---

## Proxy autostart (persistence for door 1)

Bring the proxy up on login or boot so chat attachments always work. Ready files
are in **[../autostart/](../autostart/)**:

- **Windows:** `autostart/vision-proxy.vbs`, edit the two paths, drop a shortcut in
  `shell:startup`. It launches the proxy hidden at logon.
- **Linux (systemd):** `autostart/vision-proxy.service`, edit the `ExecStart` paths,
  then `systemctl --user enable --now vision-proxy` (and `loginctl enable-linger`
  so it runs without an active login).

(The tool's persistence is the user-preset-as-default above; they are independent.)

---

## Traps

**Proxy:**

1. **Declaring image input on a route that cannot serve it is worse than
   refusing.** The failure is mid-turn and *after* the user message is durable, so
   the session retries forever. Only declare `input: [text, image]` on something
   that genuinely accepts images: the proxy, or a real multimodal endpoint.
2. **A keyless upstream still needs `apiKeyEnv`.** Omit it and pi-ai falls back to
   ambient discovery, finds nothing, and fails with `PI_AI_ERROR: No API key`.
   Point it at any env var holding any placeholder value.
3. **Describer quality is the whole ceiling.** A small model (0.8B class) is fine
   for colour, layout, and coarse content and unreliable on small text. If users
   paste text-heavy screenshots, point `--vision-model` at something larger.
4. **Images are base64-inlined**, so bodies get large. The proxy allows 64 MB and
   streams the upstream response rather than buffering.

**Tool / plugin:**

1. **Plugins resolve from the PROFILE dir**, not the install. A plugin in the
   install's `node_modules` crashes **every** profile on boot with
   `ERR_MODULE_NOT_FOUND`. Always `dsh plugin --profile <p> add link:...`.
2. **`dsh-tools` version skew.** The plugin imports `defineTool` from
   `@deepseek-ai/dsh-tools`. The npm copy is an older generation (`0.0.1-rc.1`) than
   the harness (`0.1.0-rc.6`) and imports a package that was never published, so it
   is unusable. **Link the harness's own bundled copy**, declared in `package.json`,
   not a hand-made junction, so `pnpm install` recreates it and the version stays
   checkable.
3. **Absolute Windows paths work in a PRESET but not in a profile patch.** The
   preset loader converts an absolute path to a `file:` URL before import, so
   `C:/Users/.../index.js` is valid in a preset row. The **host-plane** loader does
   no such conversion; it parses `C:` as a URL scheme and dies with
   `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A **bare package name works on both planes**,
   so use one on both.
4. **Presets mount LAZILY, on first session.** Verify by starting a real session.

---

## Restart rules

| change | restart? |
|---|---|
| `settings.yaml` (model routes, default preset) | **No**, hot-reloaded |
| preset `agent.cordis.yml` | **No**, new generation on next session (file stamp) |
| plugin `index.js` | **Yes**, ESM modules are cached per process |
| the proxy itself (`vision_shim.py`) | restart the proxy process; `dsh` is unaffected |

Stopping the browser tab does **not** stop the `dsh` server; kill the listener on
its port. Same for the proxy: kill the listener on `8900`.

---

## Residual risk

- **Sandbox note (tool).** The reference `index.js` reads images through
  **`ctx.fs`**, the sandbox-safe path that enforces the workspace boundary and
  approval policy. If your plugin surface only exposes `readFileSync`, understand
  that it **bypasses the sandbox** (the model could then read any file on disk
  through `analyze_image`), and gate the tool before running unattended.
- **The describer is the ceiling.** `fast` (and the proxy's small vision model) is
  right for colours, layout, and coarse content; use `detailed` or a larger
  `--vision-model` for small text and fine detail.
- **Remote endpoints fail loudly.** If a vision lane is down, `analyze_image` fails
  with a message naming the endpoint, and the proxy degrades to
  `[Image: (image could not be analyzed: ...)]`. Keep a small reapply-after-upgrade
  / health-check script that pings the vision endpoints (and re-adds the plugin per
  profile after an upgrade) so a bad lane is caught before a session needs it.

---

## Verified end-to-end

Not assumed, driven and observed. A text-only model handed an image block will
happily hallucinate a plausible description, which reads exactly like success, so
the test used generated solid-colour images the model could not guess:

- **Non-streaming:** solid green -> *"The image is a solid, bright green."*
- **Streaming:** solid blue -> *"a solid, uniform field of deep, saturated blue"*
  (5 chunks, clean `[DONE]`).
- Both answered by a **text-only model that returns
  `400 "is not a multimodal model"`** when handed an image directly, proving the
  words came from the proxy's vision leg, not the brain.

Reproduce it the same way: generate a couple of solid-colour PNGs, attach one and
ask its colour (proxy path) or point `analyze_image` at one (tool path), and
confirm the description is correct.

---

## A note on a native multimodal route

If you already run a real multimodal endpoint, you can point a route straight at
it with `input: [text, image]` and skip the proxy for that route; the declaration
is then true of the model itself. That swaps the brain for one that sees natively,
rather than keeping your text-only brain and delegating. The proxy exists precisely
so you do **not** have to give up the text model you want to think with.
