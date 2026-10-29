/**
 * Creates an admin, or resets an existing admin's password.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npx ts-node createAdmin.ts
 *
 * Credentials come from the environment, never from this file. Resetting the
 * password also signs that admin out everywhere (tokenVersion is bumped).
 */
import mongoose from 'mongoose';
import { User } from './src/models/User';
import { ENV } from './src/config/env';

const fail = (msg: string) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

const createOrUpdateAdmin = async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = (process.env.ADMIN_NAME || 'System Admin').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Set ADMIN_EMAIL to the admin\'s email address.');
  if (password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
    fail('Set ADMIN_PASSWORD to at least 12 characters, including letters and numbers.');
  }

  try {
    await mongoose.connect(ENV.MONGODB_URI);
    console.log('Connected to Database');

    let admin = await User.findOne({ email });

    if (admin) {
      // Assigning to `password` and saving is required — the User model hashes in
      // a pre('save') hook, so an updateOne() here would store it in plain text.
      admin.password = password;
      // Only promote, never demote: this account may be a superadmin, and hardcoding
      // 'admin' here would silently strip that on every re-run.
      if (admin.role !== 'superadmin') admin.role = 'admin';
      admin.isActive = true;
      admin.isVerified = true;
      admin.tokenVersion = (admin.tokenVersion ?? 0) + 1;
      await admin.save();
      console.log(`Admin password updated (and existing sessions revoked) for ${email}`);
    } else {
      admin = new User({
        name,
        email,
        password,
        role: 'admin',
        isActive: true,
        isVerified: true
      });
      await admin.save();
      console.log(`New admin created successfully for ${email}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

createOrUpdateAdmin();
