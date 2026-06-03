// api/upload.js
// POST /api/upload — saves parsed pipeline rows to Upstash

const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || 'Loop2026';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password, rows, filename } = req.body;

    // Auth check
    if (password !== UPLOAD_PASSWORD) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    const apiUrl = process.env.KV_REST_API_URL;
    const apiToken = process.env.KV_REST_API_TOKEN;

    if (!apiUrl || !apiToken) {
      return res.status(500).json({ error: 'Upstash credentials not configured' });
    }

    const payload = {
      rows,
      uploadedAt: new Date().toISOString(),
      filename: filename || 'unknown.csv',
      rowCount: rows.length
    };

    // SET the data in Upstash — store as JSON string
    const upstashResponse = await fetch(`${apiUrl}/set/pipeline_data`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(payload))
    });

    if (!upstashResponse.ok) {
      const err = await upstashResponse.text();
      console.error('Upstash SET failed:', upstashResponse.status, err);
      return res.status(500).json({ error: 'Failed to save to Upstash', detail: err });
    }

    return res.status(200).json({
      success: true,
      rowCount: rows.length,
      uploadedAt: payload.uploadedAt
    });

  } catch (err) {
    console.error('POST /api/upload error:', err.message);
    return res.status(500).json({ error: 'Failed to save data', detail: err.message });
  }
}
