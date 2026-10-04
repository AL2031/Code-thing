const keys = [1, 2, 3].map(i => process.env['GROQ_KEY_' + i]).filter(Boolean);
const MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

// Groq's TPM check counts (input tokens + max_completion_tokens), not what is actually generated.
// Keep the output cap small by default; callers can raise it with `max`.
const DEFAULT_MAX = 3000;
const HARD_MAX = 8000;
const BUDGET_MS = 50_000; // stay under maxDuration (60s)

// Rate limits are per key AND per model, so cooldowns are tracked per (model, key).
// Module state survives only while this serverless instance stays warm, so it is a best-effort
// optimisation: correctness comes from the per-request failover loop below.
const cooldown = {}; // `${model}|${keyIndex}` -> epoch ms when that key may be used again
let rr = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function retryAfterMs(r) {
  const s = parseFloat(r.headers.get('retry-after'));
  return Math.min(Number.isFinite(s) ? s * 1000 : 10_000, 60_000);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!keys.length) return res.status(500).json({ error: 'Set GROQ_KEY_1, GROQ_KEY_2, GROQ_KEY_3 in Vercel env vars' });
  const { model, messages, json, max, effort } = req.body || {};
  if (!MODELS.includes(model)) return res.status(400).json({ error: 'Unknown model' });

  const cap = Math.min(Math.max(parseInt(max, 10) || DEFAULT_MAX, 256), HARD_MAX);
  const body = { model, messages, temperature: 0.3, max_completion_tokens: cap };
  if (json) body.response_format = { type: 'json_object' };
  if (model.startsWith('openai/')) body.reasoning_effort = ['low', 'medium', 'high'].includes(effort) ? effort : 'low';

  // Each request starts at a different key (spreads parallel calls) and walks all keys in order.
  const start = rr++ % keys.length;
  const order = keys.map((_, k) => (start + k) % keys.length);
  const cd = i => cooldown[model + '|' + i] || 0;
  const failed = new Set(); // keys that failed this request for a non-rate-limit reason (413, 5xx, network)
  const deadline = Date.now() + BUDGET_MS;
  let last = 'No key available', status = 429;

  while (Date.now() < deadline) {
    const now = Date.now();
    const candidates = order.filter(i => !failed.has(i));
    if (!candidates.length) break;
    const ready = candidates.filter(i => cd(i) <= now);

    if (!ready.length) {
      // Every usable key is cooling down: wait for the soonest one instead of failing.
      const wait = Math.min(...candidates.map(cd)) - now;
      if (now + wait > deadline) break;
      await sleep(wait + 100);
      continue;
    }

    for (const i of ready) {
      let r, d;
      try {
        r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keys[i] },
          body: JSON.stringify(body)
        });
        d = await r.json().catch(() => ({}));
      } catch (e) { last = e.message; failed.add(i); continue; }

      if (r.ok) return res.status(200).json(d);
      last = d.error?.message || 'Groq error ' + r.status;
      status = r.status;

      if (r.status === 429) { cooldown[model + '|' + i] = Date.now() + retryAfterMs(r); continue; } // fail over now, skip this key until it resets
      if (r.status === 413 || r.status >= 500) { failed.add(i); continue; }                        // not a cooldown issue; try the others
      return res.status(r.status).json({ error: last });                                           // 400/401/etc: retrying won't help
    }
  }
  res.status(status === 413 ? 413 : 429).json({ error: `All ${keys.length} key(s) failed: ` + last });
};

module.exports.config = { maxDuration: 60 };
