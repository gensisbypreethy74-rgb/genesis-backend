/** CMS link fields may be empty, a site path ("/…" but not "//…"), or an https URL. */
export const isSafeHref = (value: unknown) =>
  value === undefined || value === null || value === '' ||
  (typeof value === 'string' && (/^\/(?!\/)/.test(value.trim()) || /^https:\/\//i.test(value.trim())));

export const UNSAFE_HREF_MESSAGE = 'Links must start with / or https://';
