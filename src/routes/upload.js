const express = require('express');
const multer = require('multer');
const pdfService = require('../services/pdfService');
const aiService = require('../services/aiService');
const n8nService = require('../services/n8nService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const question = req.body.question || '';

    if (!file) return res.status(400).json({ error: 'File required' });

    // Extract text from PDF
    const text = await pdfService.extractTextFromBuffer(file);

    // Build structured JSON using AI
    const structuredJson = await aiService.extractStructuredJSON({ text, question });

    // Send event to n8n (forward all processing metadata)xx
    await n8nService.sendToN8N({
       filename: file.originalname,
       fileSize: file.size,
       aiOutput: structuredJson,
       textSnippet: text.slice(0, 2000),
       userQuestion: question || null,
       recipientEmail: req.body.recipientEmail || null
    });

    // Return response to frontend
    return res.json({
      success: true,
      text,
      structuredJson
    });

  } catch (err) {
    console.error('process error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

