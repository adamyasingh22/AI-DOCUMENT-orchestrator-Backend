const pdfParse = require('pdf-parse');

async function extractTextFromBuffer(file) {
  // file.buffer from multer memoryStorage
  const isPdf = file.mimetype === 'application/pdf';
  if (isPdf) {
    const data = await pdfParse(file.buffer);
    return data.text;
  } else {
    return file.buffer.toString('utf8');
  }
}

module.exports = { extractTextFromBuffer };
