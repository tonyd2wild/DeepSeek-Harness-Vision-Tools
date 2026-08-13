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
//   plugin so it receives (ctx, config) at mount time. IMPORTANT: link the
//   harness's OWN copy of dsh-tools, not the npm one, see package.json and
//   "trap #2" in examples/dsh.md. The tool object's exact registration surface
//   is version-dependent; the linked copy is the source of truth for it.
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

// --- Sandbox-safe image read ------------------------------------------------
// Prefer ctx.fs: it enforces the workspace boundary and the user's file-approval
// policy, so analyze_image can only read files the session is already allowed to
// touch. Raw fs.readFileSync BYPASSES both, through this tool the model could
// then read ANY file on disk. Only fall back to it on a trusted, attended box,
// and gate it before running unattended.
async function readImageBytes(ctx, filePath) {
  const fs = ctx && ctx.fs;
  if (fs && typeof fs.readFile === "function") {
    const data = await fs.readFile(filePath); // Buffer | Uint8Array | string
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  }
  // FALLBACK, NOT sandboxed. See the warning above before relying on this.
  const { readFileSync } = await import("node:fs");
  return readFileSync(filePath);
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
export const name = "vision";

// Declare the service(s) your dsh-tools generation exposes tool registration on.
// Left optional so apply() still runs if the name differs in your copy; the
// registration block at the bottom then picks whichever surface exists.
export const inject = { optional: ["tools"] };

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
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image file to analyze.",
        },
        backend: {
          type: "string",
          enum: names,
          description:
            `Which vision backend to use. One of: ${names.join(", ")}. ` +
            `Defaults to "${defaultBackend}".`,
        },
        prompt: {
          type: "string",
          description: "What to ask the vision model about the image.",
          default: DEFAULT_PROMPT,
        },
      },
      required: ["path"],
    },

    // Returns a plain STRING, the vision model's description, which becomes the
    // tool result in the brain's context. No image bytes ever reach the brain.
    async execute(args = {}) {
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

      const bytes = await readImageBytes(ctx, filePath);
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

  // Attach the tool to the harness. defineTool() returns a descriptor; the exact
  // registration surface depends on your dsh-tools generation. Common shapes:
  //   ctx.tools.register(tool)  , an explicit tools service
  //   ctx.plugin(tool)          , the descriptor is itself a Cordis plugin
  // Check the LINKED harness copy under node_modules/@deepseek-ai/dsh-tools for
  // the export your version expects, this is exactly why we link it (trap #2).
  if (ctx.tools && typeof ctx.tools.register === "function") {
    ctx.tools.register(tool);
  } else if (typeof ctx.plugin === "function") {
    ctx.plugin(tool);
  } else {
    throw new Error(
      "[analyze_image] no tool-registration surface on ctx, check your dsh-tools version",
    );
  }
}

export default apply;
