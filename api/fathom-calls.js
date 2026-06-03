// api/fathom-calls.js
// GET /api/fathom-calls — returns last 4 weeks of calls filtered to onboarding POCs
import { POC_FATHOM_NAMES } from '../lib/specialistMap.js';

const CACHE_KEY = 'fathom_calls_4weeks';
const CACHE_TTL = 1800; // 30 min in seconds

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

    // 2. Fetch fresh from Fathom
    const fathomKey = process.env.FATHOM_API_KEY;
    if (!fathomKey) {
      return res.status(200).json({
        calls: [],
        fetchedAt: null,
        message: 'No Fathom API key configured'
      });
    }

    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const calls = await fetchAllFathomCalls(fathomKey, fourWeeksAgo.toISOString());

    // 3. Filter to onboarding POCs only
    const filtered = calls.filter(call => {
      const recorder = (call.recorded_by || '').trim().toLowerCase();
      return POC_FATHOM_NAMES.has(recorder);
    });

    const payload = {
      calls: filtered,
      total: filtered.length,
      fetchedAt: new Date().toISOString()
    };

    // 4. Cache in Upstash
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
  const MAX_PAGES = 10;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({ created_after: createdAfter, per_page: '50' });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(`https://api.fathom.video/v1/calls?${params}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

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
