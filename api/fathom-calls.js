// api/fathom-calls.js
// GET /api/fathom-calls — returns last 4 weeks of calls filtered to onboarding POCs

const POC_FATHOM_NAMES = new Set([
  "aakash revankar",
  "aditi goel",
  "aditya gupta",
  "devak grover",
  "jagrit popli",
  "ritima singh",
  "shivam kumar",
  "tarun rana",
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
      console.log('Missing FATHOM_API_KEY');
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

    // 4. Filter to onboarding POCs only
    const filtered = calls.filter(call => {
      const recorder = (call.recorded_by || '').trim().toLowerCase();
      return POC_FATHOM_NAMES.has(recorder);
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
    console.error('Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
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
  const MAX_PAGES = 10;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({ created_after: createdAfter, per_page: '50' });
    if (cursor) params.set('cursor', cursor);

    const url = `https://api.fathom.video/v1/calls?${params}`;
    console.log('Fetching URL:', url);

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Fathom response status:', response.status);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Fathom API ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const calls = data.calls || data.data || [];
    allCalls.push(...calls);

    cursor = data.next_cursor || null;
    if (!cursor || calls.length === 0) break;
    page++;
  }

  return allCalls;
}
