/** Native popover owns dismissal/focus; this adapter keeps it beside its invoker
 * and inside the viewport. File selection and conversion remain in Player. */
export default class PlayerDownloadMenu {
  constructor(canOpen) {
    this.button = document.getElementById('downloadMenuBtn');
    this.menu = document.getElementById('downloadMenu');
    this._beforeToggle = event => {
      if (event.newState === 'open' && (!canOpen() || this.button.disabled)) event.preventDefault();
    };
    this._position = () => this.position();
    this._toggle = () => {
      const open = this.menu.matches(':popover-open');
      this.button.setAttribute('aria-expanded', String(open));
      if (open) this.position();
      else this.menu.classList.remove('is-positioned');
      for (const [type, capture] of [['resize', false], ['scroll', true]]) {
        window[open ? 'addEventListener' : 'removeEventListener'](type, this._position, capture);
      }
    };
    this._keydown = event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (event.currentTarget === this.button && event.key !== 'ArrowDown') return;
      if (!canOpen() || this.button.disabled) return;
      event.preventDefault();
      if (!this.menu.matches(':popover-open')) this.menu.showPopover();
      this.position();
      const links = [...this.menu.querySelectorAll('a:not([hidden]):not([aria-disabled="true"])')];
      const index = links.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + links.length) % links.length;
      links[next]?.focus();
    };
    this.menu?.addEventListener('beforetoggle', this._beforeToggle);
    this.menu?.addEventListener('toggle', this._toggle);
    this.menu?.addEventListener('keydown', this._keydown);
    this.button?.addEventListener('keydown', this._keydown);
  }

  position() {
    if (!this.menu?.matches(':popover-open')) return;
    const anchor = this.button.getBoundingClientRect();
    if (this.button.disabled || !anchor.width || anchor.bottom < 0 || anchor.top > window.innerHeight) {
      this.close();
      return;
    }
    const { width, height } = this.menu.getBoundingClientRect();
    const edge = 16;
    const left = Math.max(edge, Math.min(anchor.right - width, window.innerWidth - width - edge));
    const below = anchor.bottom + 8;
    const top = Math.max(edge, Math.min(
      below + height <= window.innerHeight - edge ? below : anchor.top - height - 8,
      window.innerHeight - height - edge
    ));
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
    this.menu.classList.add('is-positioned');
  }

  close() {
    if (this.menu?.matches(':popover-open')) this.menu.hidePopover();
  }

  destroy() {
    if (!this.menu) return;
    this.close();
    window.removeEventListener('resize', this._position);
    window.removeEventListener('scroll', this._position, true);
    this.menu?.removeEventListener('beforetoggle', this._beforeToggle);
    this.menu?.removeEventListener('toggle', this._toggle);
    this.menu?.removeEventListener('keydown', this._keydown);
    this.button?.removeEventListener('keydown', this._keydown);
  }
}
