// plugin/vision/index.js
//
// analyze_image, a DeepSeek Harness (dsh) plugin that gives a TEXT-ONLY brain
// "eyes" without ever putting an image into the brain's context.
//
// WHY THIS SHAPE
//   dsh refuses an image on a text-only route BEFORE sending it, naming the
//   model. So you cannot just hand a screenshot to a text-only DeepSeek / Qwen /
//   Llama / Mistral brain, the harness stops it first. Instead we expose a
//   MODEL-FACING TOOL: the agent (still the text brain) calls analyze_image with
//   a file path; the tool forwards the image to a LOCAL OpenAI-compatible vision
//   model and returns a TEXT description. No image ever enters the brain's
//   context, so nothing is refused. The brain reasons over the words.
//
// HOW IT REGISTERS
//   Built with defineTool() from @deepseek-ai/dsh-tools, wrapped in a Cordis
//   plugin so it receives (ctx, config) at mount time, and registered with
//   ctx.tools.register(). Targets dsh 0.2: package.json pins the 0.2 generation
//   of dsh-tools (npm's `latest` tag for it is an older, broken generation; see
//   "trap 2" in examples/dsh.md).
//
//   `inject` must name every service read off ctx. Under dsh 0.2 (cordis 4) an
//   undeclared read throws `cannot get property "<x>" without inject`, and an
//   inject entry that names a service that never appears stops the plugin from
//   applying at all (silently: the tool just never registers).
//
//   The backend NAMES are written into the tool description at MOUNT time,
//   because the model cannot read plugin config, an unlisted backend name would
//   be unguessable to it.

import { defineTool } from "@deepseek-ai/dsh-tools";

// --- Backends ---------------------------------------------------------------
// Each backend = { url: OpenAI /v1/chat/completions endpoint, model: served id }.
// Two roles, chosen per call:
//   fast    , a tiny (~0.8B) VLM: colours, layout, coarse content. The default.
//   detailed, a larger VLM: small text, fine detail.
// The hosts/models below are PLACEHOLDERS. Point them at YOUR local vision
// servers, either through dsh plugin config (preferred) or the env vars shown.
function resolveBackends(config = {}) {
  const env = process.env;

  // Preferred: backends declared in the dsh plugin config block.
  if (config.backends && Object.keys(config.backends).length) {
    return config.backends;
  }

  // Fallback: env vars, then built-in placeholders.
  return {
    fast: {
      url: env.VISION_FAST_URL || "http://YOUR_FAST_VISION_HOST:8081/v1/chat/completions",
      model: env.VISION_FAST_MODEL || "your-fast-vlm",
    },
    detailed: {
      url: env.VISION_DETAILED_URL || "http://YOUR_DETAILED_VISION_HOST:8010/v1/chat/completions",
      model: env.VISION_DETAILED_MODEL || "your-detailed-vlm",
    },
  };
}

const DEFAULT_PROMPT = "Describe this image in detail.";

// --- Image read -------------------------------------------------------------
// A plain node:fs read. dsh 0.2's ctx.fs service is bounded TEXT I/O, so it is
// not a way to read image bytes, and reading it without declaring it in
// `inject` throws. SECURITY: this read is NOT sandboxed. It ignores the
// workspace boundary and the file-approval policy, so through this tool the
// model can have ANY readable image-typed path sent to your vision endpoint.
// Fine on a trusted, attended box; gate the tool before running unattended.
// Only image extensions are accepted, and size is capped so a huge file cannot
// be shipped to the vision server.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function readImageBytes(filePath) {
  const { readFile, stat } = await import("node:fs/promises");
  const ext = String(filePath).toLowerCase().split(".").pop();
  if (!MIME[ext]) {
    throw new Error(
      `[analyze_image] not an image file: "${filePath}" ` +
        `(expected one of: ${Object.keys(MIME).join(", ")})`,
    );
  }
  const { size } = await stat(filePath);
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`[analyze_image] image too large: ${size} bytes (max ${MAX_IMAGE_BYTES})`);
  }
  return readFile(filePath);
}

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
};
function mimeFor(filePath) {
  const ext = String(filePath).toLowerCase().split(".").pop();
  return MIME[ext] || "image/png";
}

// --- The Cordis plugin ------------------------------------------------------
export const name = "dsh-plugin-vision";

// The model-facing tool registry. Required: without it there is nothing to
// register into. (Do NOT write `{ optional: ["tools"] }`: cordis 4 reads that as
// a required service literally named "optional", which never appears, so
// apply() never runs and the tool silently never registers.)
export const inject = ["tools"];

export function apply(ctx, config = {}) {
  const backends = resolveBackends(config);
  const names = Object.keys(backends);
  if (!names.length) {
    throw new Error("[analyze_image] no backends configured");
  }
  const defaultBackend = names.includes("fast") ? "fast" : names[0];

  // The model cannot read config, so the valid backend names are baked into the
  // description at mount time. Keep this honest: only list backends that exist.
  const description =
    "Analyze an image FILE with a local vision model and return a text " +
    "description. Use this whenever you need to know what is in an image, " +
    "screenshot, photo, or camera frame, you cannot see images yourself. " +
    `Available backends: ${names.join(", ")} (default "${defaultBackend}"). ` +
    'Use "fast" for colours, layout, and coarse content; "detailed" for small ' +
    "text and fine detail.";

  const tool = defineTool({
    name: "analyze_image",
    description,
    // A PROPERTY MAP, not raw JSON Schema. rc.6 compiles this itself and marks
    // required per property; handing it `{ type: "object", properties: {...} }`
    // makes it read "type" as a parameter NAME and fail with
    // `parameters.type must be a value schema object`.
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the image file to analyze.",
      },
      backend: {
        type: "string",
        description:
          `Which vision backend to use. One of: ${names.join(", ")}. ` +
          `Defaults to "${defaultBackend}".`,
      },
      prompt: {
        type: "string",
        description: "What to ask the vision model about the image.",
      },
    },

    // Returns a plain STRING, the vision model's description, which becomes the
    // tool result in the brain's context. No image bytes ever reach the brain.
    // REQUIRED. defineTool reads `options.output.render` unconditionally, so a
    // descriptor without an `output` block throws at MOUNT:
    //
    //   TypeError: Cannot read properties of undefined (reading 'render')
    //
    // and it throws in two places that look nothing alike. Composed as a
    // host-plane row it takes the whole harness down at boot; composed the
    // documented way, as an agent-preset row, the harness boots clean and every
    // NEW SESSION silently fails to create instead -- because presets mount
    // lazily, at first session. Still required on dsh 0.2.
    //
    // `execute` below returns a plain string, so the schema is a string and
    // render receives that string directly. (If you change execute to return an
    // object, this schema and render must change with it.)
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },

    async execute(args = {}, exec) {
      const filePath = args.path;
      const backendName = args.backend || defaultBackend;
      const prompt = args.prompt || DEFAULT_PROMPT;

      if (!filePath) {
        throw new Error("[analyze_image] 'path' is required");
      }

      // Unknown backend THROWS and names the valid options. No silent fallback:
      // a silent fallback would let a typo make "detailed" quietly answer from
      // the tiny "fast" model, and you would never notice the wrong eyes ran.
      const be = backends[backendName];
      if (!be) {
        throw new Error(
          `[analyze_image] unknown backend "${backendName}". ` +
            `Valid backends: ${names.join(", ")}.`,
        );
      }

      const bytes = await readImageBytes(filePath);
      const b64 = Buffer.from(bytes).toString("base64");
      const dataUrl = `data:${mimeFor(filePath)};base64,${b64}`;

      const body = JSON.stringify({
        model: be.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: be.maxTokens || 512,
        temperature: be.temperature ?? 0.2,
      });

      // Every failure below names the ENDPOINT, so a down lane or a typo'd URL is
      // obvious in the tool-result row rather than a vague "vision failed".
      let res;
      try {
        res = await fetch(be.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // Honour the harness's cancellation (Stop button, turn abort).
          ...(exec?.signal ? { signal: exec.signal } : {}),
        });
      } catch (e) {
        throw new Error(
          `[analyze_image] cannot reach backend "${backendName}" at ${be.url}: ${e.message}`,
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `[analyze_image] backend "${backendName}" (${be.url}) returned ` +
            `HTTP ${res.status}: ${detail.slice(0, 300)}`,
        );
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new Error(
          `[analyze_image] backend "${backendName}" (${be.url}) returned no text`,
        );
      }
      return text;
    },
  });

  // Attach the tool to the harness's tool registry (declared in `inject`).
  ctx.tools.register(tool);
}

// NOTE: no `export default`. dsh's loader uses a module's default export AS the
// plugin when one exists, which would drop `name` and `inject` above and make
// the ctx.tools read throw.
