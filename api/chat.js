const keys = [1, 2, 3].map(i => process.env['GROQ_KEY_' + i]).filter(Boolean);
const MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
let n = 0;

// Groq's TPM check counts (input tokens + max_completion_tokens), not what is actually generated.
// So keep the output cap small by default and let the caller raise it only when needed.
const DEFAULT_MAX = 3000;
const HARD_MAX = 8000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!keys.length) return res.status(500).json({ error: 'Set GROQ_KEY_1, GROQ_KEY_2, GROQ_KEY_3 in Vercel env vars' });
  const { model, messages, json, max, effort } = req.body || {};
  if (!MODELS.includes(model)) return res.status(400).json({ error: 'Unknown model' });

  const cap = Math.min(Math.max(parseInt(max, 10) || DEFAULT_MAX, 256), HARD_MAX);
  const body = { model, messages, temperature: 0.3, max_completion_tokens: cap };
  if (json) body.response_format = { type: 'json_object' };
  if (model.startsWith('openai/')) body.reasoning_effort = ['low', 'medium', 'high'].includes(effort) ? effort : 'low';

  let last = '';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[n++ % keys.length]; // rotate on every call, and on every retry
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return res.status(200).json(d);
    last = d.error?.message || 'Groq error ' + r.status;
    // Retry with the next key on rate limit (429), too-large-for-this-org's-limit (413), or server errors.
    // Keys only help if they belong to different Groq organizations; same-org keys share one limit.
    if (r.status !== 429 && r.status !== 413 && r.status < 500) return res.status(r.status).json({ error: last });
  }
  res.status(429).json({ error: `All ${keys.length} key(s) failed: ` + last });
};

module.exports.config = { maxDuration: 60 };
