// ============================================================
// screen — Anthropic proxy as a Supabase Edge Function.
// Keeps the API key server-side (set ANTHROPIC_API_KEY as a function secret).
// The browser calls this instead of a Python server, so the app deploys
// as a pure static site (same model as the other tools).
// ============================================================
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY not set on the function." }, 502);

    const body = await req.json();
    const system = body.system || "";
    const user = body.user || "";
    const model = body.model || MODEL;
    if (!user) return json({ error: "Missing 'user' prompt." }, 400);

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
