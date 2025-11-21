const { Configuration, OpenAIApi } = require('openai');
const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(config);

async function extractStructuredJSON({ text, question }) {
  // A robust structured prompt to ask model to return JSON only
  const system = `You are a JSON extractor. Output ONLY valid JSON (no extra commentary). 
Return an object with keys: "summary" (short), "key_pairs" (array of objects with "key" & "value"), "confidence" (0-1). 
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

  const response = await openai.createChatCompletion({
    model: "gpt-4o-mini", 
    messages: [
      {role: 'system', content: system},
      {role: 'user', content: userPrompt}
    ],
    temperature: 0.0,
    max_tokens: 800
  });

  const textResp = response.data.choices[0].message.content;
  // try parse JSON
  try {
    return JSON.parse(textResp);
  } catch (e) {
    // fallback: ask model to reformat — but for simplicity return raw content
    return { raw: textResp, parseError: e.message };
  }
}

module.exports = { extractStructuredJSON };
