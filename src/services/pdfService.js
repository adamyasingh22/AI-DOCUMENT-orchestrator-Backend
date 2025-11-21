
function loadPdfParseSync() {
  let mod;
  try {
    mod = require('pdf-parse');
  } catch (err) {
    throw new Error(`Failed to require pdf-parse: ${err?.message ?? String(err)}`);
  }

  // Try a set of candidate properties that may hold the callable
  const candidates = [
    mod,
    mod && mod.default,
    mod && mod.pdfParse,
    mod && mod.parse,
    mod && mod.pdf,
  ];

  // find first function candidate
  const func = candidates.find(c => typeof c === 'function');

  console.log('[pdfService] require("pdf-parse") keys:', Object.keys(mod || {}), 'version-like:', mod?.version ?? null, 'candidateType:', typeof func);

  if (!func) {
    const keys = Object.keys(mod || {}).join(', ');
    throw new Error(`pdf-parse import is not a function — module keys: [${keys}]`);
  }

  return func;
}

const pdfParse = loadPdfParseSync();

async function extractTextFromBuffer(fileOrBuffer, filename = 'unknown') {
  if (!fileOrBuffer) throw new Error('No file/buffer provided to pdfService');

  let buffer;
  let mimetype;
  if (typeof fileOrBuffer === 'object' && Buffer.isBuffer(fileOrBuffer.buffer)) {
    buffer = fileOrBuffer.buffer;
    mimetype = fileOrBuffer.mimetype;
  } else if (Buffer.isBuffer(fileOrBuffer)) {
    buffer = fileOrBuffer;
    mimetype = 'application/pdf';
  } else {
    throw new Error('Invalid argument: expected multer file object or Buffer');
  }

  console.log(`[pdfService] parse attempt: name=${filename} mimetype=${mimetype} size=${buffer.length}`);

  const isPdf = (mimetype === 'application/pdf') || filename.toLowerCase().endsWith('.pdf');
  if (!isPdf) return buffer.toString('utf8');

  try {
    const data = await pdfParse(buffer);
    if (!data || typeof data.text !== 'string') {
      throw new Error('pdf-parse returned unexpected result');
    }
    return data.text;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(`pdfService: failed to extract text (${msg})`);
  }
}

module.exports = { extractTextFromBuffer };
