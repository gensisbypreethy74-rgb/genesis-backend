import { Request, Response } from 'express';
import { Newsletter } from '../models/Newsletter';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { subscribeToZohoList } from '../utils/zohoCampaigns';

// POST /newsletter/subscribe  (public)
export const subscribe = asyncHandler(async (req: Request, res: Response) => {
  console.log('\n📨 [Newsletter] Subscribe request received');
  console.log('   body:', JSON.stringify(req.body));

  const email = String(req.body.email || '').trim().toLowerCase();
  const source = req.body.source ? String(req.body.source).trim() : undefined;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log('   ❌ invalid email, rejecting');
    return errorResponse(res, 400, 'Please provide a valid email address.');
  }

  const existing = await Newsletter.findOne({ email });
  if (existing) {
    console.log(`   ℹ️  ${email} already in DB (isActive=${existing.isActive})`);
    if (!existing.isActive) {
      existing.isActive = true;
      await existing.save();
    }
    // Push to Zoho too — covers contacts added before Zoho was wired up, or a
    // resubscribe after a previous unsubscribe. Best-effort; never blocks.
    console.log('   → calling Zoho Campaigns...');
    const zoho = await subscribeToZohoList(email, source);
    console.log('   ← Zoho result:', JSON.stringify(zoho));
    // Idempotent: report success so the UI stays friendly.
    return successResponse(res, 200, 'You are already on the list.', { email, zoho });
  }

  await Newsletter.create({ email, source });
  console.log(`   ✅ saved ${email} to MongoDB`);

  // Mirror the subscriber into Zoho Campaigns. This is best-effort: the local
  // record is the source of truth, so a Zoho outage or misconfiguration must
  // not fail the subscription. Failures are logged inside the helper.
  console.log('   → calling Zoho Campaigns...');
  const zoho = await subscribeToZohoList(email, source);
  console.log('   ← Zoho result:', JSON.stringify(zoho));

  return successResponse(res, 201, 'Subscribed successfully.', { email, zoho });
});

// GET /newsletter/admin  (admin)
export const getSubscribers = asyncHandler(async (_req: Request, res: Response) => {
  const subscribers = await Newsletter.find().sort({ createdAt: -1 });
  return successResponse(res, 200, 'Subscribers fetched successfully', subscribers);
});

// DELETE /newsletter/admin/:id  (admin)
export const deleteSubscriber = asyncHandler(async (req: Request, res: Response) => {
  const sub = await Newsletter.findByIdAndDelete(req.params.id);
  if (!sub) {
    return errorResponse(res, 404, 'Subscriber not found');
  }
  return successResponse(res, 200, 'Subscriber removed successfully', { id: req.params.id });
});
