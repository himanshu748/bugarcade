import { useState } from 'react';

type Props = { api: { request: (key: string, payload?: unknown) => Promise<unknown> } };
export default function App({ api }: Props) {
  const [notes, setNotes] = useState(['Ship the rough cut']);
  const [added, setAdded] = useState(0);
  const [draft, setDraft] = useState('Book the demo slot');
  const [sync, setSync] = useState('All changes local');
  async function save() {
    const snapshot = [...notes];
    setSync('Syncing…');
    await api.request('save', { notes: snapshot });
    // A save acknowledgement updates sync status, never the newer local list.
    setSync('Synced');
  }
  return <main className="mini-app">
    <header><span className="app-icon">▤</span><div><h1>Papertrail</h1><p>Your ideas, before they disappear.</p></div></header>
    <div className="app-toolbar"><span data-testid="sync-state">{sync} · {added} added</span><button data-testid="sync" onClick={() => void save()} disabled={sync === 'Syncing…'}>Sync notes ↑</button></div>
    <ul className="notes" data-testid="notes">{notes.map((note, index) => <li key={index}><span className="note-pin" />{note}</li>)}</ul>
    <div className="input-row"><label className="sr-only" htmlFor="draft">New note</label><input id="draft" data-testid="draft" value={draft} onChange={e => setDraft(e.target.value)} maxLength={120} /><button data-testid="add-note" onClick={() => { if (draft.trim()) { setNotes(current => [...current, draft.trim()]); setAdded(n => n + 1); } }}>Add note +</button></div>
    <p className="app-footnote">{notes.length} {notes.length === 1 ? 'note' : 'notes'} in this workspace</p>
  </main>;
}
