// Small interaction helpers: press ripples, sliding segment highlight, and
// retriggerable one-shot animations.

/** Spawn a ripple at the pointer position inside any button matching `selector`. */
export function installRipples(selector: string) {
  document.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (!btn || btn.classList.contains('soon')) return;
    btn.classList.add('ripple-host');
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 1.2; // square wash, no border-radius (see .ripple)
    const el = document.createElement('span');
    el.className = 'ripple';
    el.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    btn.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  });
}

/** Move a `.seg-glider` element under the `.active` child of a container. */
export function glide(container: HTMLElement) {
  let g = container.querySelector<HTMLElement>(':scope > .seg-glider');
  if (!g) {
    g = document.createElement('span');
    g.className = 'seg-glider';
    container.prepend(g);
  }
  const active = container.querySelector<HTMLElement>('.active');
  if (!active) {
    g.style.width = '0';
    return;
  }
  g.style.left = `${active.offsetLeft}px`;
  g.style.width = `${active.offsetWidth}px`;
}

export function retrigger(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
