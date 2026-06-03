// api/enrich-call.js
// GET /api/enrich-call?recording_id=xxx
// Fetches Fathom summary + transcript → parses actions + scores sentiment locally

import Sentiment from 'sentiment';

const analyzer = new Sentiment();

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

    const fathomKey = process.env.FATHOM_API_KEY;
    if (!fathomKey) return res.status(200).json({ enriched: false, reason: 'No Fathom API key' });

    // 2. Fetch summary + transcript in parallel
    const [summaryRes, transcriptRes] = await Promise.all([
      fetch(`https://api.fathom.ai/external/v1/recordings/${recording_id}/summary`, {
        headers: { 'X-Api-Key': fathomKey }
      }),
      fetch(`https://api.fathom.ai/external/v1/recordings/${recording_id}/transcript`, {
        headers: { 'X-Api-Key': fathomKey }
      })
    ]);

    if (!summaryRes.ok && !transcriptRes.ok) {
      return res.status(200).json({ enriched: false, reason: 'Fathom fetch failed' });
    }

    // 3. Parse summary markdown → extract purpose, next steps, key takeaways
    let purpose = '';
    let loopActions = [];
    let merchantActions = [];
    let callHealth = 'on-track';
    let summaryMarkdown = '';

    if (summaryRes.ok) {
      const summaryData = await summaryRes.json();
      summaryMarkdown = summaryData?.summary?.markdown_formatted || '';
      
      if (summaryMarkdown) {
        // Extract meeting purpose (first heading content)
        const purposeMatch = summaryMarkdown.match(/##\s*Meeting Purpose[\s\S]*?\n+([^\n#]+)/i);
        if (purposeMatch) {
          // Strip markdown links [text](url) → text
          purpose = purposeMatch[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
        }

        // Detect call health from key takeaways
        const lowerMd = summaryMarkdown.toLowerCase();
        if (lowerMd.includes('blocked') || lowerMd.includes('blocker')) {
          callHealth = 'blocked';
        } else if (lowerMd.includes('at risk') || lowerMd.includes('concern') || lowerMd.includes('delay')) {
          callHealth = 'at-risk';
        }

        // Extract Next Steps section
        const nextStepsMatch = summaryMarkdown.match(/##\s*Next Steps([\s\S]*?)(?=##|$)/i);
        if (nextStepsMatch) {
          const nextStepsText = nextStepsMatch[1];
          const lines = nextStepsText.split('\n').filter(l => l.trim());

          let currentOwner = null;
          const LOOP_NAMES = ['tarun', 'aditi', 'aditya', 'jagrit', 'ritima', 'shivam', 'aakash', 'devak', 'loop'];

          lines.forEach(line => {
            // Detect owner heading e.g. "**Tarun:**" or "- **Sam:**"
            const ownerMatch = line.match(/\*\*([^*:]+)[:*]/);
            if (ownerMatch) {
              currentOwner = ownerMatch[1].trim().toLowerCase();
              return;
            }

            // Extract action item — strip markdown links and bullets
            const cleaned = line
              .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
              .replace(/^[\s\-*]+/, '')                   // leading bullets
              .trim();

            if (!cleaned || cleaned.length < 5) return;

            const isLoopOwner = currentOwner && LOOP_NAMES.some(n => currentOwner.includes(n));

            if (isLoopOwner) {
              if (loopActions.length < 4) loopActions.push(cleaned);
            } else {
              if (merchantActions.length < 3) merchantActions.push(cleaned);
            }
          });
        }
      }
    }

    // 4. Score sentiment from transcript — merchant lines only
    let sentiment = 55;
    let sentimentLabel = 'neutral';

    if (transcriptRes.ok) {
      const transcriptData = await transcriptRes.json();
      const lines = transcriptData?.transcript || [];

      // Identify the merchant speaker — the non-Loop participant
      // Loop team emails end in @loopwork.co, so merchant is anyone else
      const speakerMap = {};
      lines.forEach(l => {
        const name = l.speaker?.display_name || '';
        const email = l.speaker?.matched_calendar_invitee_email || '';
        if (name && !speakerMap[name]) {
          speakerMap[name] = email;
        }
      });

      const loopEmails = ['loopwork.co'];
      const merchantSpeakers = Object.entries(speakerMap)
        .filter(([, email]) => !loopEmails.some(d => email.includes(d)))
        .map(([name]) => name.toLowerCase());

      // Get all merchant text
      const merchantText = lines
        .filter(l => merchantSpeakers.includes((l.speaker?.display_name || '').toLowerCase()))
        .map(l => l.text)
        .join(' ');

      if (merchantText.trim()) {
        const result = analyzer.analyze(merchantText);
        // comparative score typically ranges -1 to +1
        // map to 0-100 scale: 0→10, -0.5→~0, +0.5→~100
        const raw = result.comparative;
        const mapped = Math.round(Math.min(100, Math.max(0, (raw + 0.5) * 100)));
        sentiment = mapped;
        sentimentLabel = sentiment >= 70 ? 'positive' : sentiment >= 45 ? 'neutral' : 'negative';
      }
    }

    const payload = {
      enriched: true,
      recording_id,
      purpose,
      sentiment,
      sentimentLabel,
      loopActions,
      merchantActions,
      callHealth,
      analysedAt: new Date().toISOString()
    };

    // 5. Cache for 6 hours
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
