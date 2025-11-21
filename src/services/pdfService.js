
let pdfParseModule = require('pdf-parse');

const pdfParse = (pdfParseModule && typeof pdfParseModule === 'object' && pdfParseModule.default)
  ? pdfParseModule.default
  : pdfParseModule;

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

  if (isPdf) {
    if (typeof pdfParse !== 'function') {
      throw new Error('pdf-parse import is not a function');
    }
    const data = await pdfParse(buffer);
    if (!data || typeof data.text !== 'string') {
      throw new Error('pdf-parse returned unexpected result');
    }
    return data.text;
  }

  return buffer.toString('utf8');
}

module.exports = { extractTextFromBuffer };
