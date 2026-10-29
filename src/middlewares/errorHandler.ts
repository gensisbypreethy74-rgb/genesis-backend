import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';
import logger from '../utils/logger';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  // Bad input is the caller's problem and safe to describe; anything else is
  // ours and is logged in full but never echoed back.
  let statusCode = err.statusCode || err.status || err.http_code || 500;
  let message = err.message || 'Internal Server Error';
  if (err.name === 'ValidationError' || err.name === 'MulterError') statusCode = 400;
  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid ID';
  }

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} failed: ${err.stack || err}`);
    if (ENV.NODE_ENV !== 'development') message = 'Something went wrong. Please try again.';
  }

  errorResponse(res, statusCode, message, ENV.NODE_ENV === 'development' ? err.stack : undefined);
};
