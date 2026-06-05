// api/fathom-calls.js
// GET /api/fathom-calls — returns last 4 weeks of calls filtered to onboarding POCs
// Strategy: stale-while-revalidate — ALWAYS return cache instantly, refresh in background

const POC_EMAILS = new Set([
  "aakash.revankar@loopwork.co",
  "aditi.goel@loopwork.co",
  "aditya.gupta@loopwork.co",
  "devak.grover@loopwork.co",
  "jagrit.popli@loopwork.co",
  "ritima.singh@loopwork.co",
  "shivam.kumar@loopwork.co",
  "tarun.rana@loopwork.co",
]);

const CACHE_KEY = 'fathom_calls_4weeks';
const LOCK_KEY  = 'fathom_calls_lock';
const FRESH_TTL = 1800;  // 30 min — treat as "fresh", no background refresh needed
const CACHE_TTL = 86400; // 24 hours — keep stale data in KV as long as possible
const LOCK_TTL  = 25;    // 25s — lock lifetime

// ── KV helpers ───────────────────────────────────────────────────────────────
async function kvGet(apiUrl, apiToken, key) {
  try {
    const res = await fetch(`${apiUrl}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${apiToken}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function kvSet(apiUrl, apiToken, key, value, ttl) {
  try {
    await fetch(`${apiUrl}/set/${key}/ex/${ttl}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch { /* non-fatal */ }
}

async function kvDel(apiUrl, apiToken, key) {
  try {
    await fetch(`${apiUrl}/del/${key}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiToken}` }
    });
  } catch { /* non-fatal */ }
}

// ── Background refresh (fire-and-forget) ─────────────────────────────────────
async function backgroundRefresh(apiUrl, apiToken, fathomKey) {
  // Check lock first — don't double-fetch
  const lock = await kvGet(apiUrl, apiToken, LOCK_KEY);
  if (lock) {
    console.log('Background refresh skipped — lock held');
    return;
  }

  // Acquire lock
  await kvSet(apiUrl, apiToken, LOCK_KEY, { lockedAt: new Date().toISOString() }, LOCK_TTL);
  console.log('Background refresh started');

  try {
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const calls    = await fetchAllFathomCalls(fathomKey, fourWeeksAgo.toISOString());
    const filtered = calls.filter(call => {
      const email = (call.recorded_by?.email || '').trim().toLowerCase();
      return POC_EMAILS.has(email);
    });

    const payload = {
      calls:     filtered,
      total:     filtered.length,
      fetchedAt: new Date().toISOString()
    };

    await kvSet(apiUrl, apiToken, CACHE_KEY, payload, CACHE_TTL);
    console.log('Background refresh complete —', filtered.length, 'calls cached');
  } catch (err) {
    console.error('Background refresh failed:', err.message);
  } finally {
    await kvDel(apiUrl, apiToken, LOCK_KEY);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiUrl   = process.env.KV_REST_API_URL;
  const apiToken = process.env.KV_REST_API_TOKEN;
  const kvReady  = !!(apiUrl && apiToken);

  const fathomKey = process.env.FATHOM_API_KEY;
  if (!fathomKey) {
    return res.status(200).json({ calls: [], fetchedAt: null, message: 'No Fathom API key configured' });
  }

  try {
    // ── Step 1: Always check cache first ──────────────────────────────────
    const cached = kvReady ? await kvGet(apiUrl, apiToken, CACHE_KEY) : null;

    if (cached) {
      const ageMs   = Date.now() - new Date(cached.fetchedAt).getTime();
      const isFresh = ageMs < FRESH_TTL * 1000;

      if (isFresh) {
        // Fresh — return immediately, no refresh needed
        return res.status(200).json({ source: 'cache', ...cached });
      } else {
        // Stale — return IMMEDIATELY, trigger background refresh
        // This is the key change: user never waits for Fathom
        console.log('Stale cache — returning immediately, refreshing in background');

        // Kick off background refresh (don't await — fire and forget)
        backgroundRefresh(apiUrl, apiToken, fathomKey).catch(err => {
          console.error('Background refresh error:', err.message);
        });

        return res.status(200).json({ source: 'stale', ...cached });
      }
    }

    // ── Step 2: No cache at all — cold start ──────────────────────────────
    // Only happens once ever (or after 24h with zero traffic)
    if (kvReady) {
      const lock = await kvGet(apiUrl, apiToken, LOCK_KEY);
      if (lock) {
        // Another instance is doing the cold-start fetch — ask client to retry
        console.log('Cold start lock held — asking client to retry');
        return res.status(200).json({
          calls: [],
          fetchedAt: null,
          message: 'Loading',
          retryAfter: 15
        });
      }
      // Acquire lock for cold start fetch
      await kvSet(apiUrl, apiToken, LOCK_KEY, { lockedAt: new Date().toISOString() }, LOCK_TTL);
    }

    // ── Step 3: Cold start — fetch from Fathom (only path that can be slow) ──
    console.log('Cold start — fetching from Fathom');
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    let calls;
    try {
      calls = await fetchAllFathomCalls(fathomKey, fourWeeksAgo.toISOString());
    } catch (fetchErr) {
      console.error('Fathom cold start fetch failed:', fetchErr.message);
      if (kvReady) await kvDel(apiUrl, apiToken, LOCK_KEY);
      return res.status(200).json({ calls: [], fetchedAt: null, error: fetchErr.message });
    }

    const filtered = calls.filter(call => {
      const email = (call.recorded_by?.email || '').trim().toLowerCase();
      return POC_EMAILS.has(email);
    });

    const payload = {
      calls:     filtered,
      total:     filtered.length,
      fetchedAt: new Date().toISOString()
    };

    if (kvReady) {
      await kvSet(apiUrl, apiToken, CACHE_KEY, payload, CACHE_TTL);
      await kvDel(apiUrl, apiToken, LOCK_KEY);
      console.log('Cold start complete —', filtered.length, 'calls cached');
    }

    return res.status(200).json({ source: 'fathom', ...payload });

  } catch (err) {
    console.error('GET /api/fathom-calls error:', err.message);
    if (kvReady) await kvDel(apiUrl, apiToken, LOCK_KEY).catch(() => {});
    return res.status(200).json({ calls: [], fetchedAt: null, error: err.message });
  }
}

// ── Fathom paginator ──────────────────────────────────────────────────────────
async function fetchAllFathomCalls(apiKey, createdAfter) {
  const allCalls = [];
  let cursor = null;
  let page   = 0;
  const MAX_PAGES = 20;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      created_after: createdAfter,
      per_page: '50',
      'teams[]': 'On-Boarding'
    });
    if (cursor) params.set('cursor', cursor);

    const url      = `https://api.fathom.ai/external/v1/meetings?${params}`;
    const response = await fetch(url, {
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Fathom API ${response.status}: ${errText}`);
    }

    const data  = await response.json();
    const items = data.items || [];
    allCalls.push(...items);

    cursor = data.next_cursor || null;
    if (!cursor || items.length === 0) break;
    page++;
  }

  return allCalls;
}
