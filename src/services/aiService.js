
const axios = require('axios');

/**
 * Minimal Gemini via OpenAI-compat wrapper using axios.
 *
 * Behaviour:
 * - Uses callWithRetry to handle 429/5xx/network errors (exponential backoff + jitter)
 * - Posts to Google OpenAI-compat chat/completions endpoint
 * - Tries to parse model output to JSON (multiple response-shape fallbacks)
 * - Returns { success: true, structuredJson, raw } on success or throws enriched Error
 *
 * Usage: await extractStructuredJSON({ text, question })
 */

const BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/';
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!API_KEY) {
  console.warn('GEMINI_API_KEY is not set. Set it to use Gemini via OpenAI-compat.');
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function parseRetryAfter(header) {
  if (!header) return null;
  const n = Number(header);
  if (!Number.isNaN(n)) return n * 1000;
  const t = Date.parse(header);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

async function callWithRetry(fn, opts = {}) {
  const { maxAttempts = 6, baseDelayMs = 500, maxDelayMs = 30000 } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status ?? err?.status;
      const headers = err?.response?.headers ?? {};
      const shouldRetry = !status || status === 429 || (status >= 500 && status < 600);

      if (!shouldRetry || attempt === maxAttempts) {
        const enriched = new Error(`Gemini request failed (attempt ${attempt}): ${err.message}`);
        enriched.original = err;
        enriched.status = status;
        enriched.headers = headers;
        throw enriched;
      }

      let waitMs = parseRetryAfter(headers['retry-after'] || headers['Retry-After']);
      if (waitMs === null) {
        const exp = Math.pow(2, attempt - 1);
        const cap = Math.min(maxDelayMs, baseDelayMs * exp);
        waitMs = Math.floor(Math.random() * cap); // full jitter
      } else {
        waitMs = Math.min(waitMs, maxDelayMs);
      }

      console.warn(`[gemini-retry] attempt=${attempt}/${maxAttempts} status=${status} waitMs=${waitMs} msg="${err.message}"`);
      if (headers['x-ratelimit-limit'] || headers['x-ratelimit-remaining'] || headers['x-ratelimit-reset']) {
        console.warn('x-ratelimit headers:', {
          limit: headers['x-ratelimit-limit'],
          remaining: headers['x-ratelimit-remaining'],
          reset: headers['x-ratelimit-reset'],
        });
      }

      await sleep(waitMs);
    }
  }
  // unreachable
}

/**
 * Try to extract a string reply from multiple possible response shapes.
 */
function extractTextFromResponseData(data) {
  // common OpenAI-compatible shapes
  try {
    // choices[0].message.content (could be string or object)
    const choice = data?.choices?.[0];
    if (choice) {
      // Try several possible locations
      const msg = choice.message ?? choice;
      // message could be { content: "..." } or { content: [{ type: 'output_text', text: '...' }] }
      if (typeof msg === 'string') return msg;
      if (msg?.content) {
        if (typeof msg.content === 'string') return msg.content;
        // content could be array of objects
        if (Array.isArray(msg.content)) {
          // try find string in items
          const joined = msg.content.map(c => (typeof c === 'string' ? c : (c?.text ?? JSON.stringify(c)))).join(' ');
          return joined;
        }
      }
    }

    // fallback: choices[0].text
    if (choice?.text) return choice.text;

    // another fallback: data.output_text or data.choices[0].delta?.content etc.
    if (data?.output_text) return data.output_text;
    if (choice?.delta?.content) return choice.delta.content;

    // last resort: stringify whole thing
    return JSON.stringify(data);
  } catch (e) {
    return String(data);
  }
}

/**
 * Main exported function
 */
async function extractStructuredJSON({ text, question }) {
  if (!API_KEY) {
    throw new Error('GEMINI_API_KEY not configured on server.');
  }

  const systemPrompt = `You are a JSON extractor. Output ONLY valid JSON (no extra commentary).
Return an object with keys: "summary" (short), "key_pairs" (array of objects with "key" & "value"), "confidence" (0-1).
Pick 5-8 most relevant key-value pairs related to the user's question.`;

  const userPrompt = `
Document Text:
"""${String(text).slice(0, 15000)}"""
User question: "${String(question).replace(/"/g, '\\"')}"

Produce JSON with:
- summary: 1-2 line analysis relevant to the question
- key_pairs: array of {key: <string>, value: <string>, reason: <short justification>}
- confidence: numeric between 0 and 1

Return JSON only.
  `;

  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.0,
    max_tokens: 800,
  };

  const url = `${BASE_URL}chat/completions`;
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  const resp = await callWithRetry(() => axios.post(url, payload, { headers }));

  const data = resp?.data;
  console.log('[gemini] raw response data (first 2k chars):', JSON.stringify(data).slice(0, 2000));

  const textOut = extractTextFromResponseData(data);

  // try parse JSON in a safe way
  try {
    const parsed = JSON.parse(textOut);
    return { success: true, structuredJson: parsed, raw: textOut };
  } catch (parseErr) {
    // If parsing fails, try to extract JSON substring (best-effort)
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return { success: true, structuredJson: parsed, raw: textOut };
      } catch (_) {
        // fall through
      }
    }
    // final: throw enriched error so caller falls back
    const e = new Error('Model returned non-JSON content');
    e.raw = textOut;
    e.parseError = parseErr.message;
    throw e;
  }
}

module.exports = { extractStructuredJSON };
