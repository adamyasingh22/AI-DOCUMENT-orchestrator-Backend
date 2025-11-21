// services/aiService.js
const axios = require('axios');

const BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/';
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Tunables
const TRUNCATE_CHARS = Number(process.env.GEMINI_TRUNCATE_CHARS) || 4000; // slice document to this many chars (safe default)
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 800;

if (!API_KEY) {
  console.warn('GEMINI_API_KEY not set — Gemini calls will fail until configured.');
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
 * Robust extraction of textual output from various response shapes.
 * Returns string or null.
 */
function extractTextFromResponseData(data) {
  if (!data) return null;

  try {
    // 1) OpenAI-compat shape: choices[0].message.content
    const choice = data.choices?.[0];
    if (choice) {
      const msg = choice.message ?? null;
      if (msg) {
        // content could be string
        if (typeof msg.content === 'string' && msg.content.trim().length > 0) return msg.content;
        // content could be array of chunks or objects
        if (Array.isArray(msg.content) && msg.content.length > 0) {
          // find first text-like entry
          for (const item of msg.content) {
            if (!item) continue;
            if (typeof item === 'string' && item.trim()) return item;
            if (typeof item.text === 'string' && item.text.trim()) return item.text;
            if (typeof item.content === 'string' && item.content.trim()) return item.content;
          }
        }
      }
      // legacy: choices[0].text
      if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;

      if (choice.delta?.content) {
        if (typeof choice.delta.content === 'string' && choice.delta.content.trim()) return choice.delta.content;
      }
    }

    if (Array.isArray(data.output) && data.output.length > 0) {
      for (const out of data.output) {
        if (!out) continue;
        if (typeof out.content === 'string' && out.content.trim()) return out.content;
        if (Array.isArray(out.content)) {
          for (const c of out.content) {
            if (!c) continue;
            if (typeof c.text === 'string' && c.text.trim()) return c.text;
            if (typeof c === 'string' && c.trim()) return c;
          }
        }
      }
    }

    if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;

    const joined = JSON.stringify(data);
    if (joined && joined.length > 0) return joined;

    return null;
  } catch (e) {
    return null;
  }
}

async function extractStructuredJSON({ text, question }) {
  if (!API_KEY) {
    throw new Error('GEMINI_API_KEY not configured on server.');
  }

  // Truncate large documents (configurable)
  const truncatedText = String(text || '').slice(0, TRUNCATE_CHARS);

  const systemPrompt = `You are a JSON extractor. Output ONLY valid JSON (no extra commentary).
Return an object with keys: "summary" (short), "key_pairs" (array of objects with "key" & "value"), "confidence" (0-1).
Pick 5-8 most relevant key-value pairs related to the user's question.`;

  const userPrompt = `
Document Text:
"""${truncatedText}"""
User question: "${String(question || '').replace(/"/g, '\\"')}"

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
    max_tokens: MAX_OUTPUT_TOKENS,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  const url = `${BASE_URL}chat/completions`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  const resp = await callWithRetry(() => axios.post(url, payload, { headers }));

  const data = resp?.data;
  try {
    const rawStr = JSON.stringify(data);
    console.log('[gemini] raw response data (trimmed 4000 chars):', rawStr.slice(0, 4000));
  } catch (e) {
    console.log('[gemini] raw response data (could not stringify)');
  }

  const textOut = extractTextFromResponseData(data);

  if (!textOut || !String(textOut).trim()) {
    const err = new Error('Model returned no usable output');
    err.raw = data;
    err.reason = data?.choices?.[0]?.finish_reason ?? null;
    throw err;
  }


  try {
    const parsed = JSON.parse(String(textOut).trim());
    return { success: true, structuredJson: parsed, raw: String(textOut) };
  } catch (parseErr) {
    const jsonMatch = String(textOut).match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return { success: true, structuredJson: parsed, raw: String(textOut) };
      } catch (_) {
      }
    }

    const e = new Error('Model output not valid JSON');
    e.raw = textOut;
    e.parseError = parseErr.message;
    throw e;
  }
}

module.exports = { extractStructuredJSON };
