import crypto from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import logger, { securityLogger } from '../utils/logger';
import { ENV, isProduction } from '../config/env';
import { OAuth2Client } from 'google-auth-library';

const isAdminRole = (role: string) => role === 'admin' || role === 'superadmin';

// `tv` ties the token to the user's tokenVersion so a server-side sign-out can revoke it.
const generateToken = (user: IUser) =>
  jwt.sign({ id: user._id.toString(), role: user.role, tv: user.tokenVersion ?? 0 }, ENV.JWT_SECRET, {
    expiresIn: (isAdminRole(user.role) ? ENV.ADMIN_JWT_EXPIRES_IN : ENV.JWT_EXPIRES_IN) as any,
  });

const cookieOptions = () => ({ httpOnly: true, secure: isProduction(), sameSite: 'strict' as const });

// The httpOnly cookie lives exactly as long as the token inside it.
const setAuthCookie = (res: Response, token: string) => {
  const { exp } = jwt.decode(token) as { exp: number };
  res.cookie('jwt', token, { ...cookieOptions(), maxAge: exp * 1000 - Date.now() });
};

export const loginAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const ip = req.ip || 'unknown';

  if (!email || !password) {
    return errorResponse(res, 400, 'Please provide email and password');
  }

  // Check if user exists and select password
  const user = await User.findOne({ email }).select('+password');

  if (!user || !(await user.matchPassword(password))) {
    securityLogger.loginFailure(email, ip, 'bad credentials');
    return errorResponse(res, 401, 'Invalid email or password');
  }

  if (!user.isActive) {
    securityLogger.loginFailure(email, ip, 'deactivated');
    return errorResponse(res, 403, 'Your account has been deactivated');
  }

  // Check if role is admin or superadmin
  if (!isAdminRole(user.role)) {
    securityLogger.loginFailure(email, ip, 'not an admin');
    return errorResponse(res, 403, 'Not authorized to access admin portal');
  }

  const token = generateToken(user);
  setAuthCookie(res, token);
  securityLogger.loginSuccess(user._id.toString(), user.email, ip);

  successResponse(res, 200, 'Login successful', {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    token
  });
});

interface GoogleIdentity {
  googleId: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Asks Google whether an OAuth access token is real, unexpired and issued to
 * this site's client ID, and returns the identity Google vouches for. Nothing
 * the browser says about who the user is gets trusted.
 */
async function identityFromAccessToken(accessToken: string): Promise<GoogleIdentity | null> {
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (!infoRes.ok) {
    logger.warn(`Google sign-in rejected: tokeninfo returned HTTP ${infoRes.status}`);
    return null;
  }
  const info: any = await infoRes.json();
  // A token minted for some other app must not sign anyone in here. Client IDs
  // are public (they ship in the storefront bundle), so naming them is safe and
  // makes a storefront/backend client-ID mismatch obvious in the logs.
  if (info.aud !== ENV.GOOGLE_CLIENT_ID) {
    logger.warn(`Google sign-in rejected: token issued for client ${String(info.aud).slice(0, 12)}…, but GOOGLE_CLIENT_ID is ${ENV.GOOGLE_CLIENT_ID.slice(0, 12)}…`);
    return null;
  }
  if (!info.sub || !info.email || String(info.email_verified) !== 'true') {
    logger.warn('Google sign-in rejected: no verified email on the Google account');
    return null;
  }

  // Name and picture aren't in tokeninfo; fetch them with the same token.
  let profile: any = {};
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => null);
  if (profileRes?.ok) profile = await profileRes.json();
  if (profile.sub && profile.sub !== info.sub) return null;

  return { googleId: info.sub, email: info.email, name: profile.name, picture: profile.picture };
}

async function identityFromIdToken(credential: string): Promise<GoogleIdentity | null> {
  const client = new OAuth2Client(ENV.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken: credential, audience: ENV.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || !payload.email_verified) return null;
  return { googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
}

// Google Sign-In for customers. Accepts the access token from the storefront's
// useGoogleLogin (implicit flow) or a Google ID token; both are verified with Google.
export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  // `mode` ('signin' | 'register') may still be sent; it changes nothing (see below).
  const { accessToken, credential } = req.body;

  if (!ENV.GOOGLE_CLIENT_ID) {
    return errorResponse(res, 500, 'Google OAuth is not configured');
  }

  let identity: GoogleIdentity | null = null;
  try {
    identity = accessToken ? await identityFromAccessToken(accessToken) : await identityFromIdToken(credential);
  } catch (error: any) {
    securityLogger.loginFailure('(google)', req.ip || 'unknown', `google verification error: ${error?.message}`);
  }
  if (!identity) {
    return errorResponse(res, 401, 'Invalid Google token');
  }

  // Normalize the email so casing/whitespace can't create duplicate customer accounts.
  const normalizedEmail = identity.email.trim().toLowerCase();

  try {
    // Check if this email already belongs to a customer/account (case-insensitive).
    let user = await User.findOne({ email: normalizedEmail }).collation({ locale: 'en', strength: 2 });
    const isNewUser = !user;

    // Studio accounts sign in with their password on the admin portal only, so
    // a compromised Google account can't become an admin session.
    if (user && isAdminRole(user.role)) {
      securityLogger.loginFailure(normalizedEmail, req.ip || 'unknown', 'admin account via google');
      return errorResponse(res, 403, 'Admin accounts must sign in through the admin portal.');
    }

    // Every Google button works the same way, whichever page it is on: an
    // existing customer is signed in to their account, a new one gets an
    // account. `mode` only says which page that was; it never refuses anyone.
    if (user) {
      if (!user.isActive) {
        return errorResponse(res, 403, 'Your account has been deactivated');
      }
      // Accounts are matched on the email Google has verified. One already
      // linked to a *different* Google account is refused, not re-linked: the
      // address now belongs to another Google account (a recycled work email,
      // say), which must not inherit this customer's orders and addresses.
      if (user.googleId && user.googleId !== identity.googleId) {
        securityLogger.loginFailure(normalizedEmail, req.ip || 'unknown', 'google account id mismatch');
        return errorResponse(res, 409, 'This email is linked to a different Google account. Please contact us and we will help you sign in.');
      }
      // Link Google to an account created another way, and fill in what Google
      // can add — never overwriting the customer's own name or details.
      let linked = false;
      if (!user.googleId) { user.googleId = identity.googleId; linked = true; }
      if (!user.avatar && identity.picture) { user.avatar = identity.picture; linked = true; }
      if (!user.isVerified) { user.isVerified = true; linked = true; }
      if (linked) await user.save();
    } else {
      try {
        user = await User.create({
          name: identity.name || 'Google User',
          email: normalizedEmail,
          googleId: identity.googleId,
          avatar: identity.picture,
          role: 'customer',
          isVerified: true, // Google emails are already verified
          isActive: true,
          password: crypto.randomBytes(32).toString('hex'), // never used: Google customers have no password
        });
      } catch (error: any) {
        // A second tab created this account a moment ago: sign in to that one.
        if (error?.code !== 11000) throw error;
        user = await User.findOne({ email: normalizedEmail }).collation({ locale: 'en', strength: 2 });
        if (!user || user.googleId !== identity.googleId) throw error;
      }
    }

    const token = generateToken(user);
    setAuthCookie(res, token);

    successResponse(
      res,
      200,
      isNewUser ? 'Account created successfully' : 'Signed in successfully',
      {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isNewUser,
        token
      }
    );
  } catch (error: any) {
    // Duplicate-key from the unique email index (race condition) — treat as existing account.
    if (error?.code === 11000) {
      return errorResponse(res, 409, 'This email is already registered. Please sign in.');
    }
    throw error;
  }
});

// Sign out. For studio accounts this also revokes every token issued so far
// (a stolen admin token stops working); customers just lose this session's cookie.
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  if (isAdminRole(user.role)) {
    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  }
  res.clearCookie('jwt', cookieOptions());
  successResponse(res, 200, 'Signed out', null);
});
