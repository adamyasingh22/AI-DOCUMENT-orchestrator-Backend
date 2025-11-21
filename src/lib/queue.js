// queue.js
const { default: PQueue } = require('p-queue');
const { extractStructuredJSON } = require('../services/aiService'); // adjust path if needed

const concurrency = Number(process.env.OPENAI_CONCURRENCY) || 1;   // 1 = strict
const intervalCap = Number(process.env.OPENAI_INTERVAL_CAP) || 1;  // 1 request per interval
const interval = Number(process.env.OPENAI_INTERVAL_MS) || 1000;  // 1 second

const queue = new PQueue({ concurrency, intervalCap, interval });

// debug: log queue stats if DEBUG_QUEUE=1
if (process.env.DEBUG_QUEUE === '1') {
  setInterval(() => {
    console.log(`[queue] size=${queue.size} pending=${queue.pending}`);
  }, 5000);
}

async function queuedExtractStructuredJSON(args) {
  console.log('[queue] enqueue request');
  const task = () => {
    console.log('[queue] running extractStructuredJSON');
    return extractStructuredJSON(args);
  };
  return queue.add(task);
}

module.exports = { queuedExtractStructuredJSON, queue };
