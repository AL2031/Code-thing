const keys = [1, 2, 3].map(i => process.env['GROQ_KEY_' + i]).filter(Boolean);
const MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
let n = 0;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!keys.length) return res.status(500).json({ error: 'Set GROQ_KEY_1, GROQ_KEY_2, GROQ_KEY_3 in Vercel env vars' });
  const { model, messages, json } = req.body || {};
  if (!MODELS.includes(model)) return res.status(400).json({ error: 'Unknown model' });

  const body = { model, messages, temperature: 0.3, max_completion_tokens: 8000 };
  if (json) body.response_format = { type: 'json_object' };
  if (model.startsWith('openai/')) body.reasoning_effort = 'medium';

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
    if (r.status !== 429 && r.status < 500) return res.status(r.status).json({ error: last });
  }
  res.status(429).json({ error: 'All 3 keys failed: ' + last });
};

module.exports.config = { maxDuration: 60 };
