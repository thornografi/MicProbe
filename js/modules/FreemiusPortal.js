export const FREEMIUS_PORTAL_LOGIN = 'https://customers.freemius.com/login/';

/** Shared redirect boundary; portal credentials must never reach arbitrary subdomains. */
export function freemiusPortalUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192) return null;
    const url = new URL(value);
    if (!['https://customers.freemius.com', 'https://users.freemius.com'].includes(url.origin)
        || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
