const express = require('express');
const multer = require('multer');
const pdfService = require('../services/pdfService');
const n8nService = require('../services/n8nService');
const { queuedExtractStructuredJSON } = require('../lib/queue'); 

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const question = req.body.question || '';

    if (!file) return res.status(400).json({ error: 'File required' });

    // Extract text from PDF
    const text = await pdfService.extractTextFromBuffer(file);

    // Build structured JSON using AI (queued to avoid 429s)
    const structuredJson = await queuedExtractStructuredJSON({ text, question });

    // Send event to n8n (forward all processing metadata)
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

// add to upload.js (or routes/sendWebhook.js mounted under /api)
router.post('/send-webhook', async (req, res) => {
  try {
    const { recipientEmail, subject, body, text, structuredJson, question, metadata } = req.body || {};

    if (!recipientEmail) {
      return res.status(400).json({ error: true, message: 'recipientEmail required' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
      return res.status(400).json({ error: true, message: 'invalid recipientEmail' });
    }

    const payload = {
      filename: metadata?.filename || null,
      fileSize: metadata?.fileSize || null,
      aiOutput: structuredJson || null,
      textSnippet: (text || '').slice(0, 2000),
      userQuestion: question || null,
      recipientEmail,
      subject: subject || 'Document summary',
      body: body || '',
      metadata: metadata || {},
    };

    // Delegate to your n8nService; it will throw if it fails (recommended)
    const result = await require('../services/n8nService').sendToN8N(payload);

    return res.json({ success: true, n8n: result });
  } catch (err) {
    console.error('POST /api/send-webhook error:', err && (err.stack || err));
    const upstream = err?.responseBody || err?.response?.data || undefined;
    return res.status(err?.status || 500).json({
      error: true,
      message: err?.message || 'internal server error',
      ...(upstream ? { upstream } : {}),
    });
  }
});


module.exports = router;
