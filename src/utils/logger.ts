import winston from 'winston';
import { ENV } from '../config/env';

// Logs go to stdout only: Render's disk is ephemeral and log files ended up
// committed to git with customer emails in them.
const logger = winston.createLogger({
  level: ENV.NODE_ENV === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'genesis-backend' },
  silent: ENV.NODE_ENV === 'test' && !process.env.TEST_LOGS,
  transports: [
    new winston.transports.Console({
      format: ENV.NODE_ENV === 'production'
        ? winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json())
        : winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

/** "jane.doe@gmail.com" → "ja***@gmail.com", so logs identify a customer without exposing them. */
export const maskEmail = (email?: string) => {
  if (!email || !email.includes('@')) return '(none)';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};

// Security event logger
export const securityLogger = {
  loginSuccess: (userId: string, email: string, ip: string) => {
    logger.info('Login successful', { event: 'LOGIN_SUCCESS', userId, email: maskEmail(email), ip });
  },

  loginFailure: (email: string, ip: string, reason: string) => {
    logger.warn('Login failed', { event: 'LOGIN_FAILURE', email: maskEmail(email), ip, reason });
  },

  unauthorizedAccess: (path: string, ip: string, userId?: string) => {
    logger.warn('Unauthorized access attempt', { event: 'UNAUTHORIZED_ACCESS', path, ip, userId });
  },
};

export default logger;
