import { useRef, useState } from 'react';

type Props = { api: { request: (key: string, payload?: unknown) => Promise<unknown> } };
export default function App({ api }: Props) {
  const [sent, setSent] = useState(0);
  const [state, setState] = useState('Ready to place order');
  const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSent(n => n + 1);
    setState('Sending order…');
    try { await api.request('order', { product: 'Field notes', quantity: 1 }); setState('Order confirmed'); }
    finally { inFlight.current = false; }
  }
  return <main className="mini-app"><header><span className="app-icon">▧</span><div><h1>Little Supply</h1><p>Good tools for curious people.</p></div></header>
    <div className="product"><div className="product-art">FIELD<br/>NOTES<span>No. 04</span></div><div><span className="eyebrow">ONE SET · THREE NOTEBOOKS</span><h2>Field notes</h2><p>A home for loose thoughts.</p><strong>$12.00</strong></div></div>
    <button className="wide" data-testid="place-order" onClick={() => void submit()}>Place order →</button>
    <p role="status" data-testid="order-state">{state}</p><p className="app-footnote">Order requests sent: <strong data-testid="request-count">{sent}</strong></p></main>;
}
