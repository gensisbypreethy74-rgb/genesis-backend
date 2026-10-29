import { Request, Response } from 'express';
import { getOrCreateStudioNote } from '../models/StudioNote';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { isSafeHref, UNSAFE_HREF_MESSAGE } from '../utils/safeHref';

export const getStudioNote = asyncHandler(async (_req: Request, res: Response) => {
  successResponse(res, 200, 'Studio note fetched', await getOrCreateStudioNote());
});

export const updateStudioNote = asyncHandler(async (req: Request, res: Response) => {
  if (!isSafeHref(req.body.ctaHref)) return errorResponse(res, 400, UNSAFE_HREF_MESSAGE);
  const note = await getOrCreateStudioNote();
  const { eyebrow, heading, description, ctaLabel, ctaHref } = req.body;
  if (eyebrow !== undefined) note.eyebrow = eyebrow;
  if (heading !== undefined) note.heading = heading;
  if (description !== undefined) note.description = description;
  if (ctaLabel !== undefined) note.ctaLabel = ctaLabel;
  if (ctaHref !== undefined) note.ctaHref = ctaHref;
  await note.save();
  successResponse(res, 200, 'Studio note updated', note);
});
