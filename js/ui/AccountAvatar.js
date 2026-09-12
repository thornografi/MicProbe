import { googleProfilePicture } from '../modules/GoogleProfile.js';

export function accountAvatar(user) {
  const parts = (user.name?.trim() || user.email?.trim() || '?').split(/\s+/u);
  const initials = [...new Set([0, parts.length - 1])].map(index => Array.from(parts[index])[0]).join('').toUpperCase();
  const avatar = document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initials;
  const picture = googleProfilePicture(user.picture);
  if (picture) {
    const img = document.createElement('img');
    img.alt = ''; img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
    img.addEventListener('error', () => { img.remove(); }, { once: true });
    img.src = picture;
    avatar.append(img);
  }
  return avatar;
}
