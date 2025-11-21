// services/aiService.js
// Robust, provider-agnostic HTTP AI service (no SDK wrappers)
// Uses axios only. Designed for Gemini/OpenAI style /chat/completions endpoints.

const axios = require('axios');

const REQUIRED_ENV = ['GEMINI_API_KEY']; // at minimum
const MISSING = REQUIRED_ENV.filter((k) => !process.env[k]);
if (MISSING.length) {
  console.warn(`[aiService] missing env: ${MISSING.join(', ')} — calls will likely fail`);
}

// Configurable via env
const BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const TRUNCATE_CHARS = Number(process.env.GEMINI_TRUNCATE_CHARS || 15000);
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2000);
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 4);
const INITIAL_BACKOFF_MS = Number(process.env.GEMINI_INITIAL_BACKOFF_MS || 800);
const MAX_BACKOFF_MS = Number(process.env.GEMINI_MAX_BACKOFF_MS || 30000);
const LOG_PREFIX = '[aiService]';

// axios instance
const client = axios.create({
  baseURL: BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
  },
});

// helper: sleep
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// parse Retry-After header (returns ms or null)
function parseRetryAfter(header) {
  if (!header) return null;
  // numeric seconds?
  const n = Number(header);
  if (!Number.isNaN(n)) return n * 1000;
  // try parse date
  const t = Date.parse(header);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

// generic call with retry logic. fn must return a Promise (axios call)
async function callWithRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? MAX_RETRIES;
  const initialBackoff = opts.initialBackoff ?? INITIAL_BACKOFF_MS;
  const maxBackoff = opts.maxBackoff ?? MAX_BACKOFF_MS;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      const headers = err?.response?.headers ?? {};
      const upstreamBody = err?.response?.data;

      // decide whether to retry
      const isRetryable =
        !status || status === 429 || (status >= 500 && status < 600);

      // if Retry-After header present, prefer it
      let waitMs = parseRetryAfter(headers['retry-after'] || headers['Retry-After']);
      if (waitMs === null) {
        // exponential backoff jitter
        const backoff = Math.min(maxBackoff, initialBackoff * Math.pow(2, attempt - 1));
        waitMs = Math.floor(Math.random() * backoff) + initialBackoff;
      }

      // final attempt or not retryable -> throw enriched error
      if (!isRetryable || attempt >= maxAttempts) {
        const enriched = new Error(`AI request failed: ${err.message || 'unknown error'}`);
        enriched.name = 'AIServiceError';
        enriched.attempts = attempt;
        enriched.status = status;
        enriched.responseBody = upstreamBody;
        enriched.headers = headers;
        enriched.original = err;
        // log concise details
        console.error(`${LOG_PREFIX} final failure (attempt=${attempt}) status=${status || 'N/A'} - ${err.message}`);
        if (upstreamBody) {
          // safe stringify
          try { console.error(`${LOG_PREFIX} upstream body:`, typeof upstreamBody === 'string' ? upstreamBody : JSON.stringify(upstreamBody)); } catch (_) {}
        }
        throw enriched;
      }

      // otherwise retry after waitMs
      console.warn(`${LOG_PREFIX} retryable error (attempt=${attempt} status=${status || 'N/A'}). waiting ${waitMs}ms before retry. err=${err.message}`);
      await sleep(waitMs);
      // loop to retry
    }
  }
}

// Utility to extract text output from common provider shapes
function extractTextFromResponse(data) {
  if (!data) return null;
  // OpenAI-style: data.choices[0].message.content
  if (Array.isArray(data.choices) && data.choices[0]) {
    // choice.message.content (chat completion)
    if (data.choices[0].message?.content) return data.choices[0].message.content;
    // choice.text (older completion)
    if (typeof data.choices[0].text === 'string') return data.choices[0].text;
  }
  // Google-native style: data.output_text or data.output?.[0]?.content
  if (typeof data.output_text === 'string') return data.output_text;
  if (Array.isArray(data.output) && data.output[0]) {
    if (data.output[0].content) return data.output[0].content;
    if (typeof data.output[0] === 'string') return data.output[0];
  }
  // fallback: stringified data?
  if (typeof data === 'string') return data;
  return null;
}

// Generic low-level model call (returns axios response)
async function callModelRaw(payload, opts = {}) {
  if (!API_KEY) {
    const err = new Error('GEMINI_API_KEY is not set on the server.');
    err.name = 'AIServiceConfigError';
    throw err;
  }

  const url = (opts.urlPath || '/chat/completions').replace(/^\/+/, ''); // e.g. 'chat/completions'
  const fn = () => client.post(`/${url}`, payload);
  const resp = await callWithRetry(fn, opts.callOptions);
  return resp;
}

// High-level: call the model for JSON extraction from text/question
async function extractStructuredJSON({ text = '', question = '' } = {}) {
  if (!API_KEY) {
    const err = new Error('GEMINI_API_KEY is not set on the server.');
    err.name = 'AIServiceConfigError';
    throw err;
  }

  // sanitize + truncate
  const safeText = String(text || '').replace(/```/g, '" " "');
  const truncated = safeText.slice(0, TRUNCATE_CHARS);
  const safeQuestion = String(question || '').replace(/"/g, '\\"');

  const systemPrompt = `You are a JSON extractor. Output ONLY valid JSON (no additional commentary).
Respond with an object with keys:
- summary: short string (1-2 lines)
- key_pairs: array of objects { key: string, value: string, reason: string }
- confidence: number between 0 and 1

Pick the top 5-8 most relevant key/value pairs related to the user's question.`;

  const userPrompt = `
Document Text:
"""${truncated}"""

User question: "${safeQuestion}"

Return only valid JSON that matches the described schema.
`;

  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.0,
    max_tokens: MAX_OUTPUT_TOKENS,
  };

  try {
    const resp = await callModelRaw(payload, {
      urlPath: 'chat/completions',
      callOptions: { maxAttempts: MAX_RETRIES, initialBackoff: INITIAL_BACKOFF_MS, maxBackoff: MAX_BACKOFF_MS },
    });

    const data = resp?.data;
    const textOut = extractTextFromResponse(data);

    if (!textOut || !String(textOut).trim()) {
      const e = new Error('Model returned empty output');
      e.raw = data;
      throw e;
    }

    // remove fencing
    let clean = String(textOut).trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '');
    }

    // try direct parse, fallback to extracting {...} substring
    try {
      const parsed = JSON.parse(clean);
      return { success: true, structuredJson: parsed, raw: clean, rawResponse: data };
    } catch (parseErr) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          return { success: true, structuredJson: parsed, raw: m[0], rawResponse: data };
        } catch (_) {
          // fall through
        }
      }
      const enriched = new Error('Unable to parse model output as JSON');
      enriched.parseError = parseErr?.message;
      enriched.rawOutput = clean;
      enriched.rawResponse = data;
      throw enriched;
    }
  } catch (err) {
    // normalize errors to include status/raw body where possible
    if (!err.status && err.original?.response?.status) {
      err.status = err.original.response.status;
      err.responseBody = err.original.response.data;
    }
    // log and rethrow
    console.error(`${LOG_PREFIX} extractStructuredJSON error: ${err.message || err}`);
    if (err.responseBody) {
      try { console.error(`${LOG_PREFIX} upstream:`, typeof err.responseBody === 'string' ? err.responseBody : JSON.stringify(err.responseBody)); } catch (_) {}
    }
    throw err;
  }
}

module.exports = {
  callModelRaw,
  extractStructuredJSON,
};
