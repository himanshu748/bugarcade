export function Icon({ name, size = 18, className = '' }: { name: 'arrow' | 'play' | 'reset' | 'check' | 'close' | 'code' | 'file' | 'bolt' | 'back' | 'plus' | 'external' | 'download' | 'bug' | 'menu' | 'star'; size?: number; className?: string }) {
  const paths = {
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    reset: <><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" />,
    file: <><path d="M14 3H5v18h14V8ZM14 3v6h5M8 13h8m-8 4h5" /></>,
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7Z" />,
    back: <path d="M20 12H5m6-6-6 6 6 6" />,
    plus: <path d="M12 4v16M4 12h16" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
    external: <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    bug: <><rect x="6" y="6" width="12" height="15" rx="2" /><path d="M9 2v4m6-4v4M2 10h4m12 0h4M2 17h4m12 0h4M12 6v15" /></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
