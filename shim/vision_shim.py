#!/usr/bin/env python3
"""vision-proxy, make a text-only model accept chat image attachments.

Sits in front of your text-only brain and speaks the ordinary OpenAI
/v1/chat/completions contract. When a request contains image_url blocks it
describes them with a local vision model and rewrites each block into plain
text, so the brain receives only words and never 400s on an image. Anything
without an image forwards untouched.

    composer --image--> dsh --> vision-proxy --image--> local vision model
                                     |                        |
                                     |<------ description -----|
                                     |
                                     +--"[Image: ...]" as TEXT--> your brain

This is the "image attached in chat" door. The companion analyze_image TOOL
(plugin/vision/) is the "image file on disk" door: a tool cannot serve a chat
attachment, because for the model to decide to call a vision tool the image must
reach the model first, which is the exact request dsh refuses. Ship both.

BOTH ENDS ARE YOURS TO CHOOSE. --upstream is any OpenAI-compatible text model.
--vision-model is any OpenAI-compatible multimodal endpoint. The proxy does not
care which; it only translates.

ZERO DEPENDENCIES. Python 3.8+ stdlib only, on purpose: a recipe nobody can
"pip install" wrong is a recipe that works on someone else's box.

Config (env, or CLI flag which overrides it):
  --host        SHIM_HOST        127.0.0.1
  --port        SHIM_PORT        8900
  --upstream    VISION_TARGET    http://127.0.0.1:8000   text-only brain
  --vision-url  EYES_URL         http://127.0.0.1:8081/v1/chat/completions
  --vision-model EYES_MODEL      mlx-community/Qwen3.5-0.8B-MLX-8bit
  --verbose     SHIM_LOG         1
  (env only)    EYES_PROMPT / EYES_DETAIL / EYES_MAX_TOKENS / EYES_TIMEOUT
"""
import base64, json, os, re, sys, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST       = os.environ.get("SHIM_HOST", "127.0.0.1")
PORT       = int(os.environ.get("SHIM_PORT", "8900"))
UPSTREAM   = os.environ.get("VISION_TARGET", "http://127.0.0.1:8000").rstrip("/")
EYES_URL   = os.environ.get("EYES_URL", "http://127.0.0.1:8081/v1/chat/completions")
EYES_MODEL = os.environ.get("EYES_MODEL", "mlx-community/Qwen3.5-0.8B-MLX-8bit")
DETAIL     = os.environ.get("EYES_DETAIL", "0") == "1"
EYES_MAXTOK= int(os.environ.get("EYES_MAX_TOKENS", "360" if DETAIL else "120"))
EYES_TO    = float(os.environ.get("EYES_TIMEOUT", "90"))
LOG        = os.environ.get("SHIM_LOG", "1") == "1"

# Images are base64-inlined, so request bodies get large. Allow up to 64 MB.
MAX_BODY   = 64 * 1024 * 1024

DEFAULT_PROMPT = (
    "Describe this image in detail. Transcribe any visible text exactly as it "
    "appears, including numbers, labels and UI elements. Note layout and colours."
) if DETAIL else (
    "Describe what you see in one clear sentence."
)
EYES_PROMPT = os.environ.get("EYES_PROMPT", DEFAULT_PROMPT)


def log(*a):
    if LOG:
        print("[proxy]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- vision leg
def _fetch_image_b64(url):
    """Return (b64, mime) for a data: URI or an http(s) URL."""
    if url.startswith("data:"):
        head, _, payload = url.partition(",")
        mime = head[5:].split(";")[0] or "image/jpeg"
        if ";base64" in head:
            return payload, mime
        return base64.b64encode(urllib.parse.unquote(payload).encode()).decode(), mime
    req = urllib.request.Request(url, headers={"User-Agent": "vision-proxy"})
    with urllib.request.urlopen(req, timeout=EYES_TO) as r:
        raw = r.read()
        mime = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
    return base64.b64encode(raw).decode(), mime


def describe(url):
    """Describe one image via the vision model. Never raises.

    Returns (ok, text). On failure ok is False and text is the error, so the
    caller can DEGRADE (emit a "could not be analyzed" note) rather than throw,
    letting the turn complete instead of wasting the user's whole message.
    """
    try:
        b64, mime = _fetch_image_b64(url)
    except Exception as e:
        log("image fetch failed:", e)
        return False, f"could not load image: {e}"
    body = json.dumps({
        "model": EYES_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": EYES_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        ]}],
        "max_tokens": EYES_MAXTOK,
        "temperature": 0.3,
    }).encode()
    req = urllib.request.Request(EYES_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=EYES_TO) as r:
            d = json.load(r)
        txt = (d["choices"][0]["message"]["content"] or "").strip()
        txt = re.sub(r"\s+", " ", txt)
        if not txt:
            return False, "vision model returned nothing"
        return True, txt
    except Exception as e:
        log("vision call failed:", e)
        return False, str(e)


# ------------------------------------------------------------ request rewrite
def rewrite(payload):
    """Replace image_url blocks with [Image: ...] text. Returns (payload, n).

    Per message: every image_url block becomes {"type":"text","text":"[Image:
    <description>]"}. If the message's blocks are THEN all text, the content
    collapses to a plain string (some servers are fussier about block arrays
    than plain strings). Messages with no image are forwarded untouched.
    """
    n = 0
    for msg in payload.get("messages", []):
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        if not any(isinstance(p, dict) and p.get("type") == "image_url" for p in content):
            continue                                   # no image here, leave untouched

        new_blocks, all_text = [], True
        for part in content:                           # order preserved deliberately
            if isinstance(part, dict) and part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                n += 1
                ok, text = describe(url)
                if ok:
                    log(f"image {n} -> {text[:90]}")
                    block = f"[Image: {text}]"
                else:
                    log(f"image {n} FAILED -> {text[:90]}")
                    block = f"[Image: (image could not be analyzed: {text})]"
                new_blocks.append({"type": "text", "text": block})
            elif isinstance(part, dict) and part.get("type") == "text":
                new_blocks.append(part)
            else:
                new_blocks.append(part)                # forward unknown blocks untouched
                all_text = False

        if all_text:
            msg["content"] = "\n\n".join(
                (b.get("text", "") if isinstance(b, dict) else str(b)) for b in new_blocks
            ).strip()
        else:
            msg["content"] = new_blocks
    return payload, n


# ------------------------------------------------------------------- handler
class ReuseServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):     # silence default access logging
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _too_big(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            self._send(413, json.dumps({"error": f"body too large ({n} > {MAX_BODY})"}).encode())
            return True
        return False

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz"):
            return self._send(200, json.dumps(self._health(), indent=1).encode())
        return self._proxy_simple("GET")               # /v1/models etc. pass through

    def do_POST(self):
        if self.path.rstrip("/").endswith("/chat/completions"):
            return self._chat()
        return self._proxy_simple("POST")

    # ---- health: prove all three legs, do not just report "running"
    def _health(self):
        out = {"status": "ok", "port": PORT, "upstream": UPSTREAM,
               "vision_url": EYES_URL, "vision_model": EYES_MODEL, "detail_mode": DETAIL}
        try:
            with urllib.request.urlopen(f"{UPSTREAM}/v1/models", timeout=10) as r:
                out["upstream_models"] = [m["id"] for m in json.load(r).get("data", [])]
            out["upstream_ok"] = True
        except Exception as e:
            out["upstream_ok"] = False; out["upstream_error"] = str(e)
        try:
            base = EYES_URL.split("/v1/")[0] + "/v1/models"
            with urllib.request.urlopen(base, timeout=10) as r:
                out["vision_models"] = [m["id"] for m in json.load(r).get("data", [])]
            out["vision_ok"] = True
        except Exception as e:
            out["vision_ok"] = False; out["vision_error"] = str(e)
        out["ready"] = bool(out.get("upstream_ok") and out.get("vision_ok"))
        return out

    def _proxy_simple(self, method):
        if method == "POST" and self._too_big():
            return
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n) if n else None
        req = urllib.request.Request(UPSTREAM + self.path, data=data, method=method)
        for h in ("Content-Type", "Authorization"):
            if self.headers.get(h): req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
                self._send(r.status, body, r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read())
        except Exception as e:
            self._send(502, json.dumps({"error": str(e)}).encode())

    def _chat(self):
        if self._too_big():
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send(400, json.dumps({"error": f"bad json: {e}"}).encode())

        payload, n_img = rewrite(payload)              # describe BEFORE opening upstream
        stream = bool(payload.get("stream"))
        body = json.dumps(payload).encode()
        req = urllib.request.Request(f"{UPSTREAM}/v1/chat/completions", data=body,
                                     headers={"Content-Type": "application/json"})
        if self.headers.get("Authorization"):
            req.add_header("Authorization", self.headers["Authorization"])

        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read())
        except Exception as e:
            return self._send(502, json.dumps({"error": f"upstream: {e}"}).encode())

        if not stream:
            data = resp.read()
            log(f"done ({n_img} image(s), non-stream)")
            return self._send(resp.status, data,
                              resp.headers.get("Content-Type", "application/json"))

        # Stream straight through, byte for byte, never buffering the whole
        # completion (dsh streams every turn; buffering would stall the UI).
        # HTTP/1.1 with no Content-Length needs an explicit end-of-body signal
        # or the client hangs forever, so close the connection at the end and
        # let EOF terminate the body.
        self.send_response(200)
        self.send_header("Content-Type", resp.headers.get("Content-Type", "text/event-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for chunk in iter(lambda: resp.read(1024), b""):
                self.wfile.write(chunk); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log("client disconnected mid-stream")
        log(f"done ({n_img} image(s), streamed)")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="dsh vision proxy (stdlib only)")
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--upstream", default=UPSTREAM, help="text-only brain (OpenAI-compatible)")
    ap.add_argument("--vision-url", default=EYES_URL, help="vision model /v1/chat/completions")
    ap.add_argument("--vision-model", default=EYES_MODEL, help="served vision model id")
    ap.add_argument("--verbose", action="store_true", default=LOG)
    a = ap.parse_args()
    HOST, PORT, LOG = a.host, a.port, a.verbose
    UPSTREAM  = a.upstream.rstrip("/")
    EYES_URL  = a.vision_url
    EYES_MODEL= a.vision_model
    log(f"listening {HOST}:{PORT}  upstream={UPSTREAM}  vision={EYES_URL} ({EYES_MODEL})")
    ReuseServer((HOST, PORT), Handler).serve_forever()
