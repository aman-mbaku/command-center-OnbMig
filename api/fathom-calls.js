// api/fathom-calls.js
// GET /api/fathom-calls — returns last 4 weeks of calls filtered to onboarding POCs
// Implements: lock + stale-while-revalidate to handle simultaneous cold-cache requests

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
const FRESH_TTL = 1800;  // 30 min — serve from cache, no refetch
const CACHE_TTL = 7200;  // 2 hours — keep stale data available as fallback
const LOCK_TTL  = 25;    // 25s — lock lifetime (outlasts Vercel's 10s function limit)

// ── KV helpers ──────────────────────────────────────────────────────────────
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
    // ── Step 1: Read cache ──────────────────────────────────────────────────
    const cached = kvReady ? await kvGet(apiUrl, apiToken, CACHE_KEY) : null;

    if (cached) {
      const ageMs   = Date.now() - new Date(cached.fetchedAt).getTime();
      const isFresh = ageMs < FRESH_TTL * 1000;

      // Fresh cache — return immediately, no Fathom call needed
      if (isFresh) {
        return res.status(200).json({ source: 'cache', ...cached });
      }

      // Stale cache — check if someone else is already refreshing
      if (kvReady) {
        const lock = await kvGet(apiUrl, apiToken, LOCK_KEY);
        if (lock) {
          // Another instance is fetching — return stale data immediately
          // Client will re-poll on next 5-min refresh cycle
          console.log('Lock held by another instance — returning stale data');
          return res.status(200).json({ source: 'stale', ...cached });
        }
      }
    } else if (kvReady) {
      // No cache at all — check lock
      const lock = await kvGet(apiUrl, apiToken, LOCK_KEY);
      if (lock) {
        // Someone else is fetching first-ever data — ask client to retry
        console.log('Lock held, no stale data — asking client to retry');
        return res.status(200).json({
          calls: [],
          fetchedAt: null,
          message: 'Loading',
          retryAfter: 15
        });
      }
    }

    // ── Step 2: Acquire lock ────────────────────────────────────────────────
    if (kvReady) {
      await kvSet(apiUrl, apiToken, LOCK_KEY, { lockedAt: new Date().toISOString() }, LOCK_TTL);
      console.log('Lock acquired');
    }

    // ── Step 3: Fetch from Fathom ───────────────────────────────────────────
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    console.log('Fetching Fathom calls from:', fourWeeksAgo.toISOString());

    let calls;
    try {
      calls = await fetchAllFathomCalls(fathomKey, fourWeeksAgo.toISOString());
    } catch (fetchErr) {
      // Fathom fetch failed — release lock, return stale if available
      console.error('Fathom fetch failed:', fetchErr.message);
      if (kvReady) await kvDel(apiUrl, apiToken, LOCK_KEY);
      if (cached) return res.status(200).json({ source: 'stale', ...cached });
      return res.status(200).json({ calls: [], fetchedAt: null, error: fetchErr.message });
    }

    console.log('Total calls fetched:', calls.length);

    // ── Step 4: Filter to POCs ──────────────────────────────────────────────
    const filtered = calls.filter(call => {
      const email = (call.recorded_by?.email || '').trim().toLowerCase();
      return POC_EMAILS.has(email);
    });
    console.log('Filtered POC calls:', filtered.length);

    const payload = {
      calls:     filtered,
      total:     filtered.length,
      fetchedAt: new Date().toISOString()
    };

    // ── Step 5: Store in KV (2-hour TTL so stale data is always available) ──
    if (kvReady) {
      await kvSet(apiUrl, apiToken, CACHE_KEY, payload, CACHE_TTL);
      await kvDel(apiUrl, apiToken, LOCK_KEY); // release lock
      console.log('Cache updated, lock released');
    }

    return res.status(200).json({ source: 'fathom', ...payload });

  } catch (err) {
    console.error('GET /api/fathom-calls error:', err.message);
    // Always release lock on unexpected error
    if (kvReady) await kvDel(apiUrl, apiToken, LOCK_KEY).catch(() => {});
    return res.status(200).json({ calls: [], fetchedAt: null, error: err.message });
  }
}

// ── Fathom paginator ─────────────────────────────────────────────────────────
async function fetchAllFathomCalls(apiKey, createdAfter) {
  const allCalls = [];
  let cursor = null;
  let page   = 0;
  const MAX_PAGES = 20;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      created_after: createdAfter,
      per_page: '50',
      // No team filter — rely on POC_EMAILS to gate results
      // (team filter would exclude POCs not assigned to 'On-Boarding' in Fathom)
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
