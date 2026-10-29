import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { errorResponse } from '../utils/responseHandler';
import { securityLogger } from '../utils/logger';
import { ENV } from '../config/env';

// Extend Express Request type globally
declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

export const protect = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  // Both frontends send a Bearer header. The cookie is only a fallback, so a
  // stale cookie can never override the session the caller actually presented.
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.jwt;

  if (!token) {
    return errorResponse(res, 401, 'Not authorized, no token provided');
  }

  let decoded: { id: string; tv?: number };
  try {
    decoded = jwt.verify(token, ENV.JWT_SECRET, { algorithms: ['HS256'] }) as { id: string; tv?: number };
  } catch {
    return errorResponse(res, 401, 'Not authorized, token failed');
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    return errorResponse(res, 401, 'Not authorized, user not found');
  }

  // Tokens issued before the last server-side sign-out are revoked.
  if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    return errorResponse(res, 401, 'Your session has ended. Please sign in again.');
  }

  if (!user.isActive) {
    return errorResponse(res, 403, 'User account is deactivated');
  }

  req.user = user;
  next();
});

export const authorize = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      securityLogger.unauthorizedAccess(req.originalUrl, req.ip || 'unknown', req.user?._id?.toString());
      return errorResponse(res, 403, `User role '${req.user?.role}' is not authorized to access this route`);
    }
    next();
  };
};
