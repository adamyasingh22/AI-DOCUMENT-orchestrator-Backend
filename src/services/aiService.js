// services/aiService.js
const axios = require('axios');

// <--- CONFIGURATION FIXES --->
// 1. Use the correct OpenAI-compatible endpoint structure (removes trailing slash issue)
const BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/+$/, '');
const API_KEY = process.env.GEMINI_API_KEY;

// 2. 'gemini-2.5-flash' does not exist yet. Using 'gemini-1.5-flash' (current standard).
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// 3. Tunables: Increased default truncate to 15k chars (Flash has a large context window)
const TRUNCATE_CHARS = Number(process.env.GEMINI_TRUNCATE_CHARS) || 15000;
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 2000; // Increased for "reasoning" fields

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
  const { maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 30000 } = opts;

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
        enriched.responseBody = err?.response?.data;
        throw enriched;
      }

      let waitMs = parseRetryAfter(headers['retry-after'] || headers['Retry-After']);
      if (waitMs === null) {
        const exp = Math.pow(2, attempt - 1);
        const cap = Math.min(maxDelayMs, baseDelayMs * exp);
        waitMs = Math.floor(Math.random() * cap); 
      } else {
        waitMs = Math.min(waitMs, maxDelayMs);
      }

      console.warn(`[gemini-retry] attempt=${attempt} status=${status} waitMs=${waitMs}`);
      await sleep(waitMs);
    }
  }
}

function extractTextFromResponseData(data) {
  if (!data) return null;
  try {
    // OpenAI shape
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    // Google Native shape fallback
    if (data.output_text) return data.output_text;
    return null;
  } catch (e) {
    return null;
  }
}

async function extractStructuredJSON({ text, question }) {
  if (!API_KEY) {
    throw new Error('GEMINI_API_KEY not configured on server.');
  }

  // 1. Prepare Text
  // Sanitize text to prevent breaking the prompt structure (replace triple quotes)
  const safeText = String(text || '').replace(/"""/g, '" " "'); 
  const truncatedText = safeText.slice(0, TRUNCATE_CHARS);

  // 2. YOUR EXACT PROMPTS
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

  // 3. Construct Payload
  const url = `${BASE_URL}/chat/completions`;
  
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.0,
    max_tokens: MAX_OUTPUT_TOKENS, // <--- CHANGED: "max_output_tokens" causes errors in OpenAI mode
  };

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  // 4. Execute with Retry
  const resp = await callWithRetry(() => axios.post(url, payload, { headers }));
  const data = resp?.data;
  
  // 5. Clean & Parse Output
  const textOut = extractTextFromResponseData(data);

  if (!textOut || !String(textOut).trim()) {
    const err = new Error('Model returned no usable output');
    err.raw = data;
    throw err;
  }

  // Remove Markdown code blocks if present (Gemini often adds ```json ... ```)
  let cleanJsonStr = textOut.trim();
  if (cleanJsonStr.startsWith('```')) {
    cleanJsonStr = cleanJsonStr.replace(/^```(json)?/i, '').replace(/```$/, '');
  }

  try {
    const parsed = JSON.parse(cleanJsonStr);
    return { success: true, structuredJson: parsed, raw: String(textOut) };
  } catch (parseErr) {
    // Final fallback: try to find the first '{' and last '}'
    const jsonMatch = cleanJsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return { success: true, structuredJson: JSON.parse(jsonMatch[0]), raw: String(textOut) };
      } catch (_) {}
    }

    const e = new Error('Model output not valid JSON');
    e.raw = textOut;
    e.parseError = parseErr.message;
    throw e;
  }
}

module.exports = { extractStructuredJSON };