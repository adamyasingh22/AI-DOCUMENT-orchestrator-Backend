
const { Configuration, OpenAIApi } = require('openai');

const config = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(config);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callWithRetry(fn, { maxAttempts = 6, baseDelay = 500 } = {}) {
  // maxAttempts: total tries (including first). baseDelay in ms.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // extract status code & headers if available
      const status = err?.response?.status || err?.status;
      const headers = err?.response?.headers || {};
      const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];

      const isRateLimit = status === 429;
      const isServerErr = status >= 500 && status < 600;
      const shouldRetry = isRateLimit || isServerErr || !status; 

      if (attempt === maxAttempts || !shouldRetry) {
        const enriched = new Error(`OpenAI request failed (attempt ${attempt}): ${err.message}`);
        enriched.original = err;
        enriched.status = status;
        enriched.headers = headers;
        throw enriched;
      }

      let waitMs = null;
      if (retryAfterHeader) {
        const parsed = Number(retryAfterHeader);
        if (!Number.isNaN(parsed)) {
          waitMs = parsed * 1000;
        } else {
          // attempt parse date
          const date = Date.parse(retryAfterHeader);
          if (!Number.isNaN(date)) {
            waitMs = Math.max(0, date - Date.now());
          }
        }
      }

      if (waitMs === null) {
        // exponential backoff with full jitter
        const exp = Math.pow(2, attempt - 1);
        const cap = baseDelay * exp; 
        waitMs = Math.floor(Math.random() * cap); 
      }

      console.warn(`OpenAI request error (status=${status}) on attempt ${attempt}/${maxAttempts}. Retrying after ${waitMs}ms. Message: ${err.message}`);

      await sleep(waitMs);
      // loop to retry
    }
  }
}

async function extractStructuredJSON({ text, question }) {
  const systemPrompt = `You are a JSON extractor. Output ONLY valid JSON (no extra commentary).
Return an object with keys: "summary", "key_pairs", "confidence".
Pick 5-8 most relevant key-value pairs related to the user's question.`;

  const userPrompt = `
Document Text:
"""${text.slice(0, 15000)}"""
User question: "${question}"

Produce JSON with:
- summary: 1-2 line analysis relevant to the question
- key_pairs: array of {key: <string>, value: <string>, reason: <short justification>}
- confidence: numeric between 0 and 1

Return JSON only.
  `;

  try {
    const response = await callWithRetry(() => openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 800
    }), { maxAttempts: 6, baseDelay: 500 });

    const content = response.data.choices[0].message.content;
    try {
      return JSON.parse(content);
    } catch (err) {
      return { raw: content, parseError: err.message };
    }
  } catch (error) {
    console.error('extractStructuredJSON failed:', {
      message: error.message,
      status: error.status,
      headers: error.headers,
      original: error.original && (error.original.response ? {
        data: error.original.response.data,
      } : undefined)
    });
    return { error: true, message: error.message, status: error.status };
  }
}

module.exports = { extractStructuredJSON };
