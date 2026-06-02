// api/data.js
// GET /api/data — returns the latest uploaded pipeline data
// Reads from Vercel KV store

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { kv } = await import('@vercel/kv');

    const data = await kv.get('pipeline_data');

    if (!data) {
      return res.status(200).json({
        rows: [],
        uploadedAt: null,
        uploadedBy: 'none',
        message: 'No data uploaded yet'
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('GET /api/data error:', err);
    return res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}
