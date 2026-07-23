import { Request, Response } from 'express';
import { getOrCreateMomentSettings } from '../models/MomentSettings';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse } from '../utils/responseHandler';

export const getMoment = asyncHandler(async (_req: Request, res: Response) => {
  successResponse(res, 200, 'Moment fetched', await getOrCreateMomentSettings());
});

export const updateMoment = asyncHandler(async (req: Request, res: Response) => {
  const m = await getOrCreateMomentSettings();
  const { eyebrow, title, body, shopLabel, shopHref, explainerEyebrow, steps } = req.body;
  if (eyebrow !== undefined) m.eyebrow = eyebrow;
  if (title !== undefined) m.title = title;
  if (body !== undefined) m.body = body;
  if (shopLabel !== undefined) m.shopLabel = shopLabel;
  if (shopHref !== undefined) m.shopHref = shopHref;
  if (explainerEyebrow !== undefined) m.explainerEyebrow = explainerEyebrow;
  if (Array.isArray(steps)) m.steps = steps;
  await m.save();
  successResponse(res, 200, 'Moment updated', m);
});
