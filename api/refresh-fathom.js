// api/refresh-fathom.js
// Called by GitHub Actions cron every 30 min — keeps Fathom cache warm
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).end();
  }
  const apiUrl    = process.env.KV_REST_API_URL;
  const apiToken  = process.env.KV_REST_API_TOKEN;
  const fathomKey = process.env.FATHOM_API_KEY;
  if (!fathomKey || !apiUrl || !apiToken) {
    return res.status(200).json({ ok: false, reason: 'Missing env vars' });
  }
  const CACHE_KEY = 'fathom_calls_4weeks';
  const LOCK_KEY  = 'fathom_calls_lock';
  const FRESH_TTL = 1800;   // 30 min — skip if cache is still fresh
  const CACHE_TTL = 86400;  // 24 hours
  const LOCK_TTL  = 25;
  const POC_NAMES = new Set([
    "Aakash Revankar",
    "Aditi Goel",
    "Aditya Gupta",
    "Devak Grover",
    "Jagrit Popli",
    "Ritima Singh",
    "Shivam Kumar",
    "Tarun Rana",
  ]);
  async function kvGet(key) {
    try {
      const r = await fetch(`${apiUrl}/get/${key}`, {
        headers: { 'Authorization': `Bearer ${apiToken}` }
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d.result ? JSON.parse(d.result) : null;
    } catch { return null; }
  }
  async function kvSet(key, value, ttl) {
    try {
      await fetch(`${apiUrl}/set/${key}/ex/${ttl}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(value))
      });
    } catch { }
  }
  async function kvDel(key) {
    try {
      await fetch(`${apiUrl}/del/${key}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}` }
      });
    } catch { }
  }
  try {
    // Skip if cache is still fresh
    const cached = await kvGet(CACHE_KEY);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
      if (ageMs < FRESH_TTL * 1000) {
        console.log('Cron: cache still fresh, skipping');
        return res.status(200).json({
          ok:      true,
          skipped: true,
          reason:  'Cache fresh',
          ageMin:  Math.round(ageMs / 60000)
        });
      }
    }
    // Skip if another instance is already fetching
    const lock = await kvGet(LOCK_KEY);
    if (lock) {
      console.log('Cron: lock held, skipping');
      return res.status(200).json({ ok: true, skipped: true, reason: 'Lock held' });
    }
    // Acquire lock
    await kvSet(LOCK_KEY, { lockedAt: new Date().toISOString() }, LOCK_TTL);
    // Fetch from Fathom
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const calls    = await fetchAllFathomCalls(fathomKey, fourWeeksAgo.toISOString());
    const filtered = calls.filter(c => {
      const name = (typeof c.recorded_by === 'string' ? c.recorded_by : (c.recorded_by?.name || '')).trim();
      return POC_NAMES.has(name);
    });
    const payload = {
      calls:     filtered,
      total:     filtered.length,
      fetchedAt: new Date().toISOString()
    };
    await kvSet(CACHE_KEY, payload, CACHE_TTL);
    await kvDel(LOCK_KEY);
    console.log('Cron: refreshed', filtered.length, 'calls');
    return res.status(200).json({
      ok:        true,
      total:     filtered.length,
      fetchedAt: payload.fetchedAt
    });
  } catch (err) {
    await kvDel(LOCK_KEY);
    console.error('Cron refresh error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
async function fetchAllFathomCalls(apiKey, createdAfter) {
  const allCalls = [];
  let cursor  = null;
  let page    = 0;
  const MAX_PAGES = 20;
  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      created_after: createdAfter,
      per_page:      '50',
    });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(
      `https://api.fathom.ai/external/v1/meetings?${params}`,
      { headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' } }
    );
    if (!response.ok) {
      throw new Error(`Fathom API ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    allCalls.push(...(data.items || []));
    cursor = data.next_cursor || null;
    if (!cursor || !data.items?.length) break;
    page++;
  }
  return allCalls;
}
