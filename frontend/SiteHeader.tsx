import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons';

export function SiteHeader({ brand, currentHash, onHome, onCreate }: { brand: ReactNode; currentHash: string; onHome: () => void; onCreate: () => void }) {
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => { setOpen(false); }, [currentHash]);
  useEffect(() => {
    if (!open) return;
    firstLink.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !header.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <header ref={header} className="site-header" data-menu-open={open} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); toggle.current?.focus(); }
  }}>
    <button className="brand-button" onClick={onHome} aria-label="BugArcade home">{brand}</button>
    <nav id="site-navigation" aria-label="Main navigation">
      <a ref={firstLink} href="#challenges" aria-current={currentHash === '#challenges' ? 'location' : undefined} onClick={() => setOpen(false)}>The arcade</a>
      <a href="#about" aria-current={currentHash === '#about' ? 'location' : undefined} onClick={() => setOpen(false)}>How it works</a>
      <a href="#proof" aria-current={currentHash === '#proof' ? 'location' : undefined} onClick={() => setOpen(false)}>The proof</a>
    </nav>
    <button className="button header-create" onClick={onCreate}>Create a challenge <Icon name="plus" size={16}/></button>
    <button ref={toggle} className="menu-toggle icon-button" aria-label={open ? 'Close navigation' : 'Open navigation'}
      aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(value => !value)}><Icon name={open ? 'close' : 'menu'} size={20}/></button>
  </header>;
}
