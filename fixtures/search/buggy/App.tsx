import { useState } from 'react';

type Props = { api: { request: (key: string, payload?: unknown) => Promise<unknown> } };
export default function App({ api }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [settled, setSettled] = useState(0);
  async function search(value: string) {
    setQuery(value);
    if (!value.trim()) return;
    const data = await api.request('search', { query: value }) as { items: string[] };
    setResults(data.items);
    setSettled(n => n + 1);
  }
  return <main className="mini-app"><header><span className="app-icon">⌕</span><div><h1>Finders</h1><p>A fast little library search.</p></div></header>
    <label htmlFor="query">Search the library</label><input id="query" data-testid="query" value={query} onChange={e => void search(e.target.value)} placeholder="Try re, then react…" autoComplete="off" maxLength={80}/>
    <div className="results" data-testid="results">{results.length ? results.map(item => <div key={item}>↗ <span>{item}</span></div>) : <p className="empty-message">Your next good read is a search away.</p>}</div>
    <p className="app-footnote" data-testid="search-state">{settled} searches settled</p></main>;
}
