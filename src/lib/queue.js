
const { default: PQueue } = require('p-queue');
const { extractStructuredJSON } = require('../services/aiService'); 

const concurrency = Number(process.env.OPENAI_CONCURRENCY) || 2;
const intervalCap = Number(process.env.OPENAI_INTERVAL_CAP) || 5;
const interval = Number(process.env.OPENAI_INTERVAL_MS) || 1000;

const queue = new PQueue({
  concurrency,
  intervalCap,
  interval,
});

async function queuedExtractStructuredJSON(args) {
  return queue.add(() => extractStructuredJSON(args));
}

module.exports = { queuedExtractStructuredJSON, queue };
