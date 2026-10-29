import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { ENV } from './config/env';
import apiRoutes from './routes';
import { razorpayWebhook } from './controllers/paymentController';
import { errorHandler } from './middlewares/errorHandler';
import { notFoundHandler } from './middlewares/notFoundHandler';
import { sanitizeInput } from './middlewares/sanitize';
import { apiLimiter } from './middlewares/rateLimiter';
import logger from './utils/logger';

const app: Application = express();
app.set("trust proxy", 1);



// Security Middlewares
// Helmet - sets various HTTP headers for security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// CORS configuration
const allowedOrigins = ENV.CORS_ORIGIN.split(",").map(o => o.trim());

const corsConfig = {
  origin: function (origin: string | undefined, callback: any) {
    // Allow requests with no origin (mobile apps, Postman, Razorpay webhooks, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked request from origin: ${origin}`);
      callback(Object.assign(new Error("Not allowed by CORS"), { statusCode: 403 }));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

// Razorpay signs webhooks over the exact raw bytes, so this route must receive
// the body before any JSON parser or sanitizer rewrites it.
app.post('/api/v1/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), razorpayWebhook);

// Body parsers with size limits. Images go through multer, so JSON stays small.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Sanitization middleware - prevent NoSQL injection
app.use(sanitizeInput);

// Rate limiting - apply to all API routes
app.use('/api/', apiLimiter);

// Logger
if (ENV.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else if (ENV.NODE_ENV === 'production') {
  app.use(morgan('combined', {
    stream: {
      write: (message: string) => logger.info(message.trim()),
    },
  }));
}

// Root — a friendly 200 for uptime pings / platform health checks so `GET /`
// and `HEAD /` don't log as 404s (Render probes the root by default).
app.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    service: 'Genesis by Preethy — API',
    status: 'live',
    health: '/api/v1/health',
  });
});

// API Routes
app.use('/api/v1', apiRoutes);

// 404 Handler
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

export default app;
