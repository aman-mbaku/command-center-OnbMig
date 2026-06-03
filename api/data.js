// api/data.js
// GET /api/data — returns latest uploaded pipeline data from Upstash

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiUrl = process.env.KV_REST_API_URL;
    const apiToken = process.env.KV_REST_API_TOKEN;

    if (!apiUrl || !apiToken) {
      console.log('Missing Upstash credentials');
      return res.status(200).json({
        rows: [],
        uploadedAt: null,
        message: 'No data uploaded yet (credentials missing)'
      });
    }

    // GET the stored data from Upstash
    const response = await fetch(`${apiUrl}/get/pipeline_data`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`
      }
    });

    if (!response.ok) {
      console.error('Upstash fetch failed:', response.status);
      return res.status(200).json({
        rows: [],
        uploadedAt: null,
        message: 'No data available'
      });
    }

    const result = await response.json();
    
    // Upstash returns { result: "..." } or null if key doesn't exist
    if (!result.result) {
      return res.status(200).json({
        rows: [],
        uploadedAt: null,
        message: 'No data uploaded yet'
      });
    }

    // Parse the stored JSON data
    const data = JSON.parse(result.result);
    return res.status(200).json(data);

  } catch (err) {
    console.error('GET /api/data error:', err.message);
    return res.status(200).json({
      rows: [],
      uploadedAt: null,
      message: 'Error fetching data',
      error: err.message
    });
  }
}
