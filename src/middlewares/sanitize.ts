import mongoSanitize from 'express-mongo-sanitize';
import logger from '../utils/logger';

// Strip `$` / `.` operator keys so request data can't become a Mongo query.
// (HTML is not filtered here: both frontends render CMS text through React,
// which escapes it, and link fields are checked with isSafeHref.)
export const sanitizeInput = mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn(`Potential NoSQL injection attempt detected: ${key} in ${req.path}`);
  },
});
