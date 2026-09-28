# Giving `dsh` eyes, the real integration guide

Everything here is model-agnostic and sanitized. Swap the placeholder hosts,
model ids, and env names for your own.

Written for **dsh 0.2.0-rc.1+**, where all configuration lives in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` (default `$DSH_HOME` is `~/.dsh`).
Apply every step to each profile you use: `web` for the browser UI, `desktop`
for DeepSeek's desktop app (no public download yet; it is built from
[DeepSeek's source](https://github.com/deepseek-ai/deepseek-harness)). For dsh 0.1.x, use this repo's
[`dsh-0.1` tag](https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools/tree/dsh-0.1).

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

`dsh` model routes are the `providers` of the `llm-pi-ai` row in your profile's
`cordis.patch.yml`. Point `baseURL` at the **proxy**, not the upstream, and
declare `input: [text, image]`:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      vision-proxy:                        # any provider id you like
        displayName: Your Text Model (via vision proxy)
        apiKeyEnv: YOUR_PLACEHOLDER_KEY_ENV # any env var holding any non-empty value
        api: openai-completions
        baseURL: http://127.0.0.1:8900/v1   # the PROXY, not the upstream
        models:
          - id: your-text-model-id
            name: Your Text Model (via vision proxy)
            contextWindow: 262144
            maxTokens: 32768
            input: [text, image]
      # ...every provider you already had stays listed here too...
```

**A patch replaces the row's whole `config`.** If your file already has an
`llm-pi-ai` row (an upgrade from 0.1 migrates your old `settings.yaml` routes
into one), add the new provider to it rather than writing a second row, and
keep every existing provider in the list.

`input: [text, image]` is **true of the proxy** even though it is false of your
brain. The route describes what it talks to, and it talks to the proxy, which
genuinely accepts images.

Restart `dsh`, pick the entry in the model picker, and attach an image.

### 3. Keep a no-proxy fallback route

The proxy is a single point of failure. Keep a **second route pointing straight at
the upstream with no `input` declared**, so there is always a way to work when the
proxy is down:

```yaml
      text-only-direct:                    # a sibling of vision-proxy above
        displayName: Your Text Model (direct, no vision)
        apiKeyEnv: YOUR_PLACEHOLDER_KEY_ENV
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1   # the upstream itself
        models:
          - id: your-text-model-id
            name: Your Text Model (direct)
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

Copy `plugin/vision/` to a stable path, e.g. `~/.dsh/plugins/vision`, and install
its one dependency, `@deepseek-ai/dsh-tools`, which `package.json` pins to the
dsh 0.2 line (see **trap 2** below for why):

```sh
cd ~/.dsh/plugins/vision
pnpm install --ignore-scripts
```

### 2. Add it PER PROFILE, never into the install's `node_modules`

```sh
dsh plugin --profile web     add link:/absolute/path/to/.dsh/plugins/vision
dsh plugin --profile desktop add link:/absolute/path/to/.dsh/plugins/vision
```

`dsh plugin` shells out to **pnpm**, which must be installed. Plugins resolve from
the **profile directory**, not the install; dropping one into the install's
`node_modules` makes **every profile crash on boot** with `ERR_MODULE_NOT_FOUND`
(trap 1).

### 3. Configure the two backends

Two roles, chosen per call. Set them in the `config:` of the tool's preset row
(step 4) as `backends: { fast: { url, model }, detailed: { url, model } }`, or
via env:

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

### 4. Make it the default with an upgrade-safe PRESET ROW

This is the tool's "works on every session" persistence, and it survives
`npm i -g @deepseek-ai/dsh`. In the web UI and the desktop app, model-facing
tool rows are disabled at the host plane; the **agent preset** is what makes a
tool visible. On 0.2 a preset is an `@deepseek-ai/dsh-agent-preset` row in
`cordis.patch.yml` (`~/.dsh/.agent-presets/` folders are no longer read).

1. **Declare your OWN preset row with a DISTINCT id** (e.g. `standard-vision`).
   You cannot append one tool to the shipped `standard` preset: a patch
   replaces a row's whole `config`, and a preset row is not a group you can
   insert into. So your row holds the shipped standard plugin list, copied
   verbatim, plus the `tool-vision` row. The shipped list is in your install at
   `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
   (or run `dsh --profile web --dump-default-config` and find `preset-standard`).
   Duplicate preset ids fail to load, so do not reuse `standard`.

   ```yaml
   - insert:
       - id: preset-standard-vision
         name: '@deepseek-ai/dsh-agent-preset'
         config:
           id: standard-vision
           name: Standard + Vision
           order: 0
           plugins:
             # ...the shipped standard preset's plugins, unchanged...
             - id: tool-vision
               name: 'dsh-plugin-vision'
               config:
                 backends:
                   fast:
                     url: http://YOUR_FAST_VISION_HOST:8081/v1/chat/completions
                     model: your-fast-vlm
                   detailed:
                     url: http://YOUR_DETAILED_VISION_HOST:8010/v1/chat/completions
                     model: your-detailed-vlm
   ```

2. **Make it the default:**

   ```yaml
   - id: agent-preset-registry
     config:
       default: standard-vision
   ```

   One preset is the default, so if another community tool already gave you a
   custom preset row, append `tool-vision` to that row instead.

3. **Re-copy after upgrades.** Your row is a snapshot of the shipped standard
   preset. When a `dsh` upgrade changes the shipped list, refresh your copy and
   keep your tool rows at the end.

> **Presets mount LAZILY, on first session** (trap 5). A clean boot proves nothing.
> Restart `dsh`, then verify by starting a **real session**.

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

(The tool's persistence is the preset-row-as-default above; they are independent.)

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
   `@deepseek-ai/dsh-tools`. npm's `latest` tag for that package is still an old
   generation (`0.0.1-rc.1`) that imports a package that was never published, so
   an unpinned install gives you an unusable copy. `package.json` therefore pins
   `^0.2.0-rc.1`, the same generation as the harness. If you move `dsh` to a new
   minor line, move that range with it and re-run `pnpm install`.
3. **Declare every `ctx` service you read in `inject`.** Under 0.2, reading a
   service the plugin did not declare throws
   `cannot get property "<name>" without inject`. An `inject` entry naming a
   service that never appears keeps the plugin from applying at all, silently:
   `{ optional: ["tools"] }` is read as a required service called "optional".
   And do not add an `export default`: the loader then uses it as the plugin and
   ignores the `name` / `inject` exports.
4. **Absolute Windows paths work in a PRESET but not in a profile patch.** The
   preset loader converts an absolute path to a `file:` URL before import, so
   `C:/Users/.../index.js` is valid in a preset row. The **host-plane** loader does
   no such conversion; it parses `C:` as a URL scheme and dies with
   `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A **bare package name works on both planes**,
   so use one on both.
5. **Presets mount LAZILY, on first session.** Verify by starting a real session.
6. **`web` and `desktop` are separate profiles.** Each has its own
   `cordis.patch.yml` and its own installed plugins. Wiring one does nothing for
   the other.

---

## Restart rules

| change | restart? |
|---|---|
| `cordis.patch.yml` (model routes, preset rows, default preset) | **Restart `dsh`** to be sure; some rows hot-reload, a restart is the reliable test |
| plugin added with `dsh plugin ... add` | **Yes** |
| plugin `index.js` | **Yes**, ESM modules are cached per process |
| the proxy itself (`vision_shim.py`) | restart the proxy process; `dsh` is unaffected |

Restarting means: web UI, stop the `dsh web` process and start it again (closing
the browser tab does **not** stop the server); desktop app, quit it fully and
reopen it. After any restart, open a **new** session. For the proxy, kill the
listener on `8900`.

---

## Residual risk

- **Sandbox note (tool).** `analyze_image` reads the image with a plain
  `node:fs` read, because dsh 0.2's `ctx.fs` service is bounded text I/O and
  cannot return image bytes. That read **bypasses the sandbox**: it ignores the
  workspace boundary and the file-approval policy, so the model can have any
  readable image file sent to your vision endpoint. The tool only accepts image
  extensions and caps size at 20 MB, but gate it before running unattended.
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
