const axios = require('axios');

const N8N_URL = process.env.N8N_WEBHOOK_URL;

exports.sendToN8N = async (payload) => {
  if (!N8N_URL) {
    console.warn('N8N_WEBHOOK_URL not configured — skipping n8n event.');
    return;
  }

  try {
    await axios.post(N8N_URL, payload, { timeout: 15000 });
    console.log('Event sent to n8n successfully');
  } catch (err) {
    console.warn('Failed to send event to n8n:', err?.response?.data || err.message);
  }
};
