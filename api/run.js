// Runs a shell command against the project's files inside a Vercel Sandbox (isolated Firecracker microVM).
// The sandbox is a separate machine: it does NOT see this function's env vars (GROQ keys).
// Auth to Sandbox is automatic on Vercel (OIDC token); locally run `vercel env pull`.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { files, cmd } = req.body || {};
  if (!files || typeof files !== 'object' || typeof cmd !== 'string' || !cmd.trim() || cmd.length > 500)
    return res.status(400).json({ error: 'Need {files, cmd}' });
  const entries = Object.entries(files).filter(([, c]) => typeof c === 'string');
  if (entries.length > 200 || entries.reduce((n, [, c]) => n + c.length, 0) > 2e6)
    return res.status(413).json({ error: 'Project too large to run' });
  if (entries.some(([p]) => p.startsWith('/') || p.split('/').includes('..')))
    return res.status(400).json({ error: 'Bad file path' });

  let sandbox;
  try {
    const { Sandbox } = await import('@vercel/sandbox'); // ESM package, so dynamic import from CJS
    sandbox = await Sandbox.create({ runtime: /^\s*(python|pip)/.test(cmd) ? 'python3.13' : 'node24', timeout: 90_000 });
    const dirs = [...new Set(entries.map(([p]) => p.split('/').slice(0, -1).join('/')).filter(Boolean))];
    if (dirs.length) await sandbox.runCommand('mkdir', ['-p', ...dirs]);
    await sandbox.writeFiles(entries.map(([path, c]) => ({ path, content: Buffer.from(c) })));
    const r = await sandbox.runCommand('timeout', ['40', 'bash', '-lc', cmd]); // stay inside maxDuration
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
    res.status(200).json({ stdout: stdout.slice(-20000), stderr: stderr.slice(-20000), exitCode: r.exitCode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { await sandbox?.stop(); await sandbox?.delete?.() } catch {}
  }
};

module.exports.config = { maxDuration: 60 };
