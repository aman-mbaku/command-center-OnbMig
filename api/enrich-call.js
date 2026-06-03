// api/enrich-call.js
// GET /api/enrich-call?recording_id=xxx
// Fetches Fathom summary → sends to Claude → returns enriched sentiment + actions

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { recording_id } = req.query;
  if (!recording_id) return res.status(400).json({ error: 'recording_id is required' });

  const apiUrl   = process.env.KV_REST_API_URL;
  const apiToken = process.env.KV_REST_API_TOKEN;
  const CACHE_KEY = `fathom_enrich_${recording_id}`;

  try {
    // 1. Check cache first
    if (apiUrl && apiToken) {
      const cacheRes = await fetch(`${apiUrl}/get/${CACHE_KEY}`, {
        headers: { 'Authorization': `Bearer ${apiToken}` }
      });
      if (cacheRes.ok) {
        const cacheData = await cacheRes.json();
        if (cacheData.result) {
          return res.status(200).json({ source: 'cache', ...JSON.parse(cacheData.result) });
        }
      }
    }

    // 2. Fetch summary from Fathom
    const fathomKey = process.env.FATHOM_API_KEY;
    if (!fathomKey) return res.status(200).json({ error: 'No Fathom API key configured' });

    const summaryRes = await fetch(
      `https://api.fathom.ai/external/v1/recordings/${recording_id}/summary`,
      { headers: { 'X-Api-Key': fathomKey } }
    );

    if (!summaryRes.ok) {
      const errText = await summaryRes.text();
      console.error('Fathom summary error:', summaryRes.status, errText);
      return res.status(200).json({ error: `Fathom ${summaryRes.status}`, enriched: false });
    }

    const summaryData = await summaryRes.json();
    const summaryText = summaryData?.summary?.markdown_formatted || null;

    if (!summaryText) {
      return res.status(200).json({ enriched: false, reason: 'No summary available yet' });
    }

    // 3. Send to Claude for analysis
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are analysing a call summary from a SaaS onboarding team (Loop Subscriptions). 
Extract structured data and return ONLY a valid JSON object — no markdown, no backticks, no explanation.`,
        messages: [{
          role: 'user',
          content: `Analyse this call summary and return a JSON object with exactly these fields:

{
  "sentiment": <integer 0-100, where 0=very negative, 50=neutral, 100=very positive>,
  "sentimentLabel": <"positive" if sentiment>=70, "neutral" if 45-69, "negative" if <45>,
  "loopActions": <array of up to 4 action items that the Loop/onboarding team needs to do>,
  "merchantActions": <array of up to 3 action items that the merchant/customer needs to do>,
  "summary": <one sentence (max 20 words) capturing the key outcome of this call>
}

Call summary:
${summaryText}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude error:', claudeRes.status, errText);
      return res.status(200).json({ enriched: false, reason: 'Claude analysis failed' });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    let enriched;
    try {
      enriched = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('Claude JSON parse error:', e.message, rawText);
      return res.status(200).json({ enriched: false, reason: 'Could not parse Claude response' });
    }

    const payload = {
      enriched: true,
      recording_id,
      sentiment: enriched.sentiment ?? 55,
      sentimentLabel: enriched.sentimentLabel ?? 'neutral',
      loopActions: enriched.loopActions ?? [],
      merchantActions: enriched.merchantActions ?? [],
      summary: enriched.summary ?? '',
      analysedAt: new Date().toISOString()
    };

    // 4. Cache for 6 hours — enrichment doesn't change
    if (apiUrl && apiToken) {
      await fetch(`${apiUrl}/set/${CACHE_KEY}/ex/21600`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(payload))
      });
    }

    return res.status(200).json({ source: 'live', ...payload });

  } catch (err) {
    console.error('GET /api/enrich-call error:', err.message);
    return res.status(200).json({ enriched: false, error: err.message });
  }
}
