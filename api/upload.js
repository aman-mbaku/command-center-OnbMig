// api/upload.js
// POST /api/upload — saves parsed pipeline rows to Vercel KV
// Body: { password: string, rows: array, filename: string }

const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || 'Loop2026';

export default async function handler(req, res) {
  // Handle CORS preflight
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

    const { kv } = await import('@vercel/kv');

    const payload = {
      rows,
      uploadedAt: new Date().toISOString(),
      filename: filename || 'unknown.csv',
      rowCount: rows.length
    };

    // Store in KV — persists until next upload
    await kv.set('pipeline_data', payload);

    return res.status(200).json({
      success: true,
      rowCount: rows.length,
      uploadedAt: payload.uploadedAt
    });

  } catch (err) {
    console.error('POST /api/upload error:', err);
    return res.status(500).json({ error: 'Failed to save data', detail: err.message });
  }
}
