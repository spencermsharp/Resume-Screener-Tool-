// ============================================================
// screen — Anthropic proxy as a Supabase Edge Function.
// Keeps the API key server-side (set ANTHROPIC_API_KEY as a function secret).
// The browser calls this instead of a Python server, so the app deploys
// as a pure static site (same model as the other tools).
//
// Health check: POST {health:true} → always HTTP 200 with {ok, model?, reason?}.
// Uses GET /v1/models (free, no tokens) to confirm the key is accepted.
// ============================================================
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5";
// Only these models may be requested by the browser; anything else uses MODEL.
const ALLOWED_MODELS = new Set([MODEL, "claude-sonnet-4-5"]);
const MAX_USER_CHARS = 60000;
const MAX_SYSTEM_CHARS = 8000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function health(key: string | undefined) {
  if (!key) return json({ ok: false, reason: "ANTHROPIC_API_KEY is not set on the function." });
  try {
    const resp = await fetch(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    });
    await resp.body?.cancel();
    if (resp.status === 200) return json({ ok: true, model: MODEL });
    if (resp.status === 401 || resp.status === 403) {
      return json({ ok: false, reason: "Anthropic rejected the API key (invalid or expired)." });
    }
    return json({ ok: false, reason: `Anthropic returned ${resp.status}` });
  } catch (e) {
    return json({ ok: false, reason: `Could not reach Anthropic: ${(e as Error).message || "network error"}` });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    const body = await req.json();
    if (body && body.health === true) return await health(key);

    if (!key) return json({ error: "ANTHROPIC_API_KEY not set on the function." }, 502);

    const system = typeof body.system === "string" ? body.system : "";
    const user = typeof body.user === "string" ? body.user : "";
    const model = typeof body.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : MODEL;
    if (!user) return json({ error: "Missing 'user' prompt." }, 400);
    if (user.length > MAX_USER_CHARS) return json({ error: `User prompt too long (max ${MAX_USER_CHARS} characters).` }, 400);
    if (system.length > MAX_SYSTEM_CHARS) return json({ error: `System prompt too long (max ${MAX_SYSTEM_CHARS} characters).` }, 400);

    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens: 1500, system, messages: [{ role: "user", content: user }] }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: `Anthropic error ${resp.status}: ${detail.slice(0, 400)}` }, 502);
    }
    const data = await resp.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!text) return json({ error: "Empty response from Anthropic." }, 502);
    return json({ text, model });
  } catch (e) {
    return json({ error: (e as Error).message || "Server error" }, 500);
  }
});
