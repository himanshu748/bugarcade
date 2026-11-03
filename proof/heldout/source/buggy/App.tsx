import { useMemo, useState } from 'react';

type API = { request: (key: string, payload?: unknown) => Promise<unknown> };
type Coupon = { code: string; percent: number };
const unitPrice = 24;
const money = (value: number) => `$${value.toFixed(2)}`;

export default function App({ api }: { api: API }) {
  const [quantity, setQuantity] = useState(2);
  const [coupon, setCoupon] = useState('WELCOME10');
  const [discount, setDiscount] = useState(0);
  const [status, setStatus] = useState('No coupon applied');
  const [pending, setPending] = useState(false);
  const total = useMemo(() => quantity * unitPrice * (1 - discount / 100), [quantity]);

  async function applyCoupon() {
    setPending(true);
    setStatus('Checking coupon…');
    try {
      const response = await api.request('validate-coupon', { code: coupon }) as Coupon;
      setDiscount(response.percent);
      setStatus(`Coupon applied · ${response.percent}% off`);
    } catch {
      setStatus('Coupon could not be applied');
    } finally {
      setPending(false);
    }
  }

  return <main className="mini-app">
    <header><span className="app-icon" aria-hidden="true">↗</span><div><h1>Camp Supply</h1><p>Your weekend starts here.</p></div></header>
    <div className="app-toolbar"><strong>Your basket</strong><span>2-day dispatch</span></div>
    <section className="board-preview" aria-label="Basket item">
      <h2>Trail cup</h2><p>Insulated stainless steel · {money(unitPrice)} each</p>
      <div className="input-row"><span>Quantity: <strong data-testid="quantity">{quantity}</strong></span><button data-testid="increase-quantity" onClick={() => setQuantity(value => value + 1)}>Add one</button></div>
    </section>
    <label htmlFor="coupon">Discount code</label>
    <div className="input-row"><input id="coupon" data-testid="coupon" value={coupon} onChange={event => setCoupon(event.target.value)} aria-describedby="coupon-status"/><button data-testid="apply-coupon" disabled={pending} onClick={applyCoupon}>{pending ? 'Checking…' : 'Apply coupon'}</button></div>
    <p id="coupon-status" data-testid="discount-status" role="status">{status}</p>
    <div className="app-toolbar"><span>Coupon saving</span><strong>{money(quantity * unitPrice * discount / 100)}</strong></div>
    <div className="app-toolbar"><h2>Order total</h2><h2 data-testid="total">{money(total)}</h2></div>
    <p className="app-footnote">Free delivery. Prices include tax. Your total should include any applied coupon.</p>
  </main>;
}
