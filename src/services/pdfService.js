
async function loadPdfParse() {
  const mod = await import('pdf-parse').catch(err => {
    throw new Error(`Failed to import pdf-parse: ${err?.message ?? String(err)}`);
  });

  const pdfParseCandidate = mod.default ?? mod;

  console.log('[pdfService] pdf-parse module keys:', Object.keys(mod || {}), 'type of candidate:', typeof pdfParseCandidate);

  if (typeof pdfParseCandidate !== 'function') {
    throw new Error('pdf-parse import is not a function');
  }

  return pdfParseCandidate;
}

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

  const isPdf = (mimetype === 'application/pdf') || filename.toLowerCase().endsWith('.pdf');

  console.log(`[pdfService] parse attempt: name=${filename} mimetype=${mimetype} size=${buffer.length}`);

  if (!isPdf) {
    return buffer.toString('utf8');
  }

  // load and call pdf-parse
  const pdfParse = await loadPdfParse();
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
