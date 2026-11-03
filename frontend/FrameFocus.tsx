import { useEffect } from 'react';

// An embedded document can own focus without its iframe matching :focus.
// Reflect only the host's active element; never inspect the child document.
export function FrameFocus() {
  useEffect(() => {
    let pending = 0;
    const sync = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const active = document.activeElement;
        document.querySelectorAll('iframe').forEach(frame => {
          frame.toggleAttribute('data-embedded-focus', frame === active);
        });
      });
    };
    window.addEventListener('blur', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    sync();
    return () => {
      cancelAnimationFrame(pending);
      window.removeEventListener('blur', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
      document.querySelectorAll('iframe[data-embedded-focus]').forEach(frame => frame.removeAttribute('data-embedded-focus'));
    };
  }, []);
  return null;
}
