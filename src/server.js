require('dotenv').config();
const express = require('express');
const cors = require('cors');

const uploadRoutes = require('./routes/upload');

const app = express();

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    if (allowed.includes(origin)) return callback(null, true);
    return callback(new Error('CORS not allowed by server'), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
  console.log('Incoming origin:', req.headers.origin);
  next();
});

app.use(express.json({ limit: '10mb' }));

app.use('/api', uploadRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
