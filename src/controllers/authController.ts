import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { securityLogger } from '../utils/logger';
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
  if (!infoRes.ok) return null;
  const info: any = await infoRes.json();
  // A token minted for some other app must not sign anyone in here.
  if (info.aud !== ENV.GOOGLE_CLIENT_ID || !info.sub || !info.email || String(info.email_verified) !== 'true') {
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
  const { accessToken, credential, mode } = req.body;

  // Which screen the request came from: 'register' (sign up) or 'signin' (sign in).
  const authMode = mode === 'register' ? 'register' : mode === 'signin' ? 'signin' : undefined;

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

    // Signing in requires an existing account.
    if (authMode === 'signin' && !user) {
      return errorResponse(res, 404, 'You are not signed up. Please create an account first.');
    }

    // Signing up requires the account to not already exist.
    if (authMode === 'register' && user) {
      return errorResponse(res, 409, 'You are already signed up. Please sign in instead.');
    }

    if (user) {
      // Email already exists — reuse the existing account instead of creating a duplicate.
      if (!user.isActive) {
        return errorResponse(res, 403, 'Your account has been deactivated');
      }
      // Link the Google ID if this account was created another way.
      if (!user.googleId) {
        user.googleId = identity.googleId;
        await user.save();
      }
    } else {
      // No existing customer with this email — create a new account.
      user = await User.create({
        name: identity.name || 'Google User',
        email: normalizedEmail,
        googleId: identity.googleId,
        avatar: identity.picture,
        role: 'customer',
        isVerified: true, // Google emails are already verified
        isActive: true,
        password: `google_${identity.googleId}_${Date.now()}`, // Random password since Google users don't need one
      });
    }

    const token = generateToken(user);
    setAuthCookie(res, token);

    successResponse(
      res,
      200,
      isNewUser ? 'Account created successfully' : 'This email is already registered. Signed you in.',
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
