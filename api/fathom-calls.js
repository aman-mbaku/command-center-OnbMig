// api/fathom-calls.js
// GET /api/fathom-calls — returns last 4 weeks of calls filtered to onboarding POCs

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
const CACHE_TTL = 1800;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiUrl   = process.env.KV_REST_API_URL;
  const apiToken = process.env.KV_REST_API_TOKEN;

  try {
    // 1. Try cache first
    if (apiUrl && apiToken) {
      const cacheRes = await fetch(`${apiUrl}/get/${CACHE_KEY}`, {
        headers: { 'Authorization': `Bearer ${apiToken}` }
      });
      if (cacheRes.ok) {
        const cacheData = await cacheRes.json();
        if (cacheData.result) {
          const parsed = JSON.parse(cacheData.result);
          return res.status(200).json({ source: 'cache', ...parsed });
        }
      }
    }

    // 2. Check Fathom API key
    const fathomKey = process.env.FATHOM_API_KEY;
    console.log('FATHOM_API_KEY present:', !!fathomKey);

    if (!fathomKey) {
      return res.status(200).json({
        calls: [],
        fetchedAt: null,
        message: 'No Fathom API key configured'
      });
    }

    // 3. Fetch last 4 weeks from Fathom
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    console.log('Fetching from:', fourWeeksAgo.toISOString());

    const calls = await fetchAllFathomCalls(fathomKey, fourWeeksAgo.toISOString());
    console.log('Total calls fetched:', calls.length);

    // 4. Filter to onboarding POCs by email
    const filtered = calls.filter(call => {
      const email = (call.recorded_by?.email || '').trim().toLowerCase();
      return POC_EMAILS.has(email);
    });
    console.log('Filtered POC calls:', filtered.length);

    const payload = {
      calls: filtered,
      total: filtered.length,
      fetchedAt: new Date().toISOString()
    };

    // 5. Cache in Upstash
    if (apiUrl && apiToken) {
      await fetch(`${apiUrl}/set/${CACHE_KEY}/ex/${CACHE_TTL}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(payload))
      });
    }

    return res.status(200).json({ source: 'fathom', ...payload });

  } catch (err) {
    console.error('GET /api/fathom-calls error:', err.message);
    return res.status(200).json({
      calls: [],
      fetchedAt: null,
      message: 'Error fetching Fathom data',
      error: err.message
    });
  }
}

async function fetchAllFathomCalls(apiKey, createdAfter) {
  const allCalls = [];
  let cursor = null;
  let page = 0;
  const MAX_PAGES = 20;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      created_after: createdAfter,
      per_page: '50',
      'teams[]': 'On-Boarding'
    });
    if (cursor) params.set('cursor', cursor);

    const url = `https://api.fathom.ai/external/v1/meetings?${params}`;
    console.log('Fetching:', url);

    const response = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    console.log('Fathom response status:', response.status);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Fathom API ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const items = data.items || [];
    allCalls.push(...items);

    cursor = data.next_cursor || null;
    if (!cursor || items.length === 0) break;
    page++;
  }

  return allCalls;
}
