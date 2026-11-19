// #region stonkbot news classifier shim
// Tiny host-side service that runs `claude --print` under Filip's subscription
// (via ~/.claude), so the Dockerized stonkbot bot can classify news headlines
// without an API key. The container reaches this over host.docker.internal.
//
// Runs as user `filip` under systemd (stonkbot-classifier.service). Mirrors the
// Spotify DJ pattern: a native host process shelling out to the claude CLI.
// Gated by a shared bearer token (CLASSIFIER_TOKEN) since it binds broadly.
const PORT = Number(process.env.CLASSIFIER_PORT ?? "8772");
const BIND = process.env.CLASSIFIER_BIND ?? "0.0.0.0";
const TOKEN = process.env.CLASSIFIER_TOKEN ?? "";
const MODEL = process.env.CLASSIFIER_MODEL ?? "haiku";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "/home/filip/.local/bin/claude";
const CALL_TIMEOUT_MS = 90_000;

// #region harness trim
// `claude --print` normally wraps a prompt in the whole Claude Code agent: its
// default system prompt, every built-in tool definition, the MCP server schemas
// and Filip's CLAUDE.md. Measured on a real 20-ticker sentiment prompt, that was
// 25,855 input tokens carrying a 1,167-token payload, plus 2,807 thinking tokens
// to emit a flat JSON array. The same call with the harness stripped: 1,766 in,
// 574 out, 0 thinking, 5.9s instead of 32s.
//
// These two are classification calls, not agent runs. They need no tools, no
// MCP, no project context and no reasoning budget, so none of that is loaded.
// MAX_THINKING_TOKENS=0 turns off extended thinking for the spawned process.
const LEAN_ARGS = [
  "--system-prompt", "You are a JSON classifier. Reply with only the requested JSON.",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--setting-sources", "",
];
const LEAN_ENV = { ...process.env, MAX_THINKING_TOKENS: "0" };

// Spawn one lean classification call and return the model's raw text.
async function runClaude(prompt: string, label: string): Promise<string> {
  const started = Date.now();
  const proc = Bun.spawn(
    [CLAUDE_BIN, "--print", "--model", MODEL, "--output-format", "json", ...LEAN_ARGS, prompt],
    { stdout: "pipe", stderr: "pipe", env: LEAN_ENV },
  );
  const killer = setTimeout(() => proc.kill(), CALL_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  if (code !== 0) throw new Error(`claude exited ${code}: ${err.slice(0, 300)}`);

  const envelope = JSON.parse(out) as {
    result?: string;
    is_error?: boolean;
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`claude envelope error: ${out.slice(0, 300)}`);
  }
  // Log the per-call token cost so a regression in the trim is visible in the
  // journal rather than only in a monthly usage total.
  const u = envelope.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  console.log(`[${label}] ${input} in / ${u.output_tokens ?? 0} out, ${Date.now() - started}ms`);
  return envelope.result;
}

// Claude sometimes wraps JSON in a ```json fence despite instructions; strip it.
function stripFence(text: string): string {
  const s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fence ? fence[1]!.trim() : s;
}
// #endregion

if (!TOKEN) {
  console.error("Refusing to start: CLASSIFIER_TOKEN is empty.");
  process.exit(1);
}

interface Verdict {
  materialNegative: boolean;
  reason: string;
}

function parseVerdict(resultText: string): Verdict {
  const obj = JSON.parse(stripFence(resultText)) as Verdict;
  if (typeof obj.materialNegative !== "boolean") throw new Error("verdict missing materialNegative");
  return { materialNegative: obj.materialNegative, reason: String(obj.reason ?? "") };
}

function buildPrompt(symbol: string, headlines: string[]): string {
  const list = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");
  return (
    `A long-only dip-buying bot wants to buy ${symbol} because it dipped intraday inside an ` +
    `uptrend. You are a defensive filter: decide whether the recent headlines below indicate ` +
    `genuinely material NEGATIVE news that likely explains the dip and makes buying risky (a ` +
    `real repricing), versus routine, neutral, or positive coverage that a large-cap always ` +
    `generates. Flag materialNegative=true ONLY for real adverse catalysts (earnings/guidance ` +
    `miss, cut outlook, failed trial, regulatory/legal action, fraud, major downgrade, executive ` +
    `scandal, collapsed deal). Analyst reiterations, product news, partnerships, or positive ` +
    `items => false.\n\nHeadlines (last 24h):\n${list}\n\n` +
    `Respond with ONLY a JSON object, no prose and no code fence: ` +
    `{"materialNegative": boolean, "reason": "<=12 word explanation"}`
  );
}

async function classify(symbol: string, headlines: string[]): Promise<Verdict> {
  return parseVerdict(await runClaude(buildPrompt(symbol, headlines), `classify ${symbol}`));
}

// Batch sentiment: one claude call tags every symbol's recent news as
// positive / neutral / negative, for the dashboard watchlist. One call per
// cycle instead of one per symbol.
type Sentiment = "great" | "positive" | "neutral" | "negative" | "terrible";
const SENTIMENTS: readonly Sentiment[] = ["great", "positive", "neutral", "negative", "terrible"];

interface SentimentRow {
  symbol: string;
  sentiment: Sentiment;
  reason: string;
}

async function classifyBatch(items: { symbol: string; headlines: string[] }[]): Promise<SentimentRow[]> {
  const blocks = items
    .map((it) => `### ${it.symbol}\n${it.headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}`)
    .join("\n\n");
  const prompt =
    `For each ticker below, classify the overall tone of its recent headlines for a stock ` +
    `trader on a FIVE-level scale. Judge the substance, not the volume:\n` +
    `- "great": standout bullish catalyst (blowout earnings, raised guidance, major upgrade, ` +
    `winning approval/deal).\n` +
    `- "positive": generally favorable/constructive coverage.\n` +
    `- "neutral": routine, mixed, or immaterial.\n` +
    `- "negative": generally adverse/bearish coverage.\n` +
    `- "terrible": genuinely alarming catalyst (guidance cut, earnings miss, failed trial, ` +
    `fraud, regulatory/legal action, executive scandal, collapsed deal).\n\n${blocks}\n\n` +
    `Respond with ONLY a JSON array, no prose and no code fence, one entry per ticker with ` +
    `the same symbols: [{"symbol":"XXX","sentiment":"great|positive|neutral|negative|terrible","reason":"<=8 words"}]`;

  const arr = JSON.parse(stripFence(await runClaude(prompt, `sentiment x${items.length}`))) as SentimentRow[];
  if (!Array.isArray(arr)) throw new Error("batch result not an array");
  // Coerce any off-scale label to neutral so the row still carries a usable tag.
  return arr.map((r) => ({
    ...r,
    sentiment: SENTIMENTS.includes(r?.sentiment) ? r.sentiment : "neutral",
  }));
}

const server = Bun.serve({
  port: PORT,
  hostname: BIND,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    if (req.method !== "POST" || (url.pathname !== "/classify" && url.pathname !== "/sentiment")) {
      return new Response("not found", { status: 404 });
    }
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }

    let body: { symbol?: string; headlines?: unknown; items?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }

    // Batch sentiment for the watchlist.
    if (url.pathname === "/sentiment") {
      const items = Array.isArray(body.items)
        ? (body.items as { symbol?: unknown; headlines?: unknown }[])
            .slice(0, 40)
            .map((it) => ({
              symbol: String(it.symbol ?? "").slice(0, 12),
              headlines: Array.isArray(it.headlines)
                ? it.headlines.slice(0, 10).map((h) => String(h).slice(0, 300))
                : [],
            }))
            .filter((it) => it.symbol && it.headlines.length > 0)
        : [];
      if (items.length === 0) return Response.json({ results: [] });
      try {
        return Response.json({ results: await classifyBatch(items) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[sentiment] ${msg}`);
        return Response.json({ error: msg }, { status: 502 });
      }
    }

    // Single-symbol adverse-catalyst gate for the buy decision.
    const symbol = String(body.symbol ?? "").slice(0, 12);
    const headlines = Array.isArray(body.headlines)
      ? body.headlines.slice(0, 10).map((h) => String(h).slice(0, 300))
      : [];
    if (!symbol || headlines.length === 0) {
      return Response.json({ error: "symbol and headlines required" }, { status: 400 });
    }

    try {
      const verdict = await classify(symbol, headlines);
      return Response.json(verdict);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[classify] ${symbol}: ${msg}`);
      return Response.json({ error: msg }, { status: 502 });
    }
  },
});

console.log(`stonkbot-classifier on http://${BIND}:${server.port} (model=${MODEL})`);
// #endregion
