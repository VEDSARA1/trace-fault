import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import apiRoutes from './routes/api.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

// Security and middleware
app.use(helmet());
app.use(compression());
app.use(express.json());

// CORS config - only allow frontend origin
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Rate limiting to prevent abuse
// Sized against real usage, not a round number: one analysis costs ~22 requests
// (1 txlist + 1 address-type + up to 20 traces) plus up to 20 more if the user
// expands every card. At the old limit of 200 a user hit this after ~8 analyses,
// and our 429 is indistinguishable from Etherscan's to the client — so it
// surfaced as "rate-limited" transactions rather than as a server-side cap.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 600, // ~15 full analyses per window
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api', limiter);

// Mount API routes
app.use('/api', apiRoutes);

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
