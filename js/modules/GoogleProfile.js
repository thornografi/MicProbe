/** Optional display data, never an account identifier or an entitlement. */
export function googleProfilePicture(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return '';
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^lh\d+\.googleusercontent\.com$/.test(url.hostname)
        || url.username || url.password || url.port) return '';
    return url.href;
  } catch { return ''; }
}
