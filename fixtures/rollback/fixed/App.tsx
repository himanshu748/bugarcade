import { useRef, useState } from 'react';

type Props = { api: { request: (key: string, payload?: unknown) => Promise<unknown> } };
export default function App({ api }: Props) {
  const [title, setTitle] = useState('Untitled board');
  const [settled, setSettled] = useState(0);
  const [message, setMessage] = useState('Changes save in the background');
  const revision = useRef(0);
  async function rename(next: string) {
    const previous = title;
    const ownRevision = ++revision.current;
    setTitle(next);
    try { await api.request('rename', { title: next }); if (revision.current === ownRevision) setMessage('Rename saved'); }
    catch { if (revision.current === ownRevision) { setTitle(previous); setMessage('Rename failed'); } }
    finally { setSettled(n => n + 1); }
  }
  return <main className="mini-app"><header><span className="app-icon">◫</span><div><h1>Boardroom</h1><p>A little space for your next big thing.</p></div></header>
    <div className="board-preview"><span className="eyebrow">WORKSPACE TITLE</span><h2 data-testid="board-title">{title}</h2><div className="board-lines"><i /><i /><i /></div></div>
    <p>Choose a name. It appears immediately.</p><div className="input-row"><button data-testid="rename-weekend" onClick={() => void rename('Weekend project')}>Weekend project</button><button data-testid="rename-launch" onClick={() => void rename('Launch board')}>Launch board</button></div>
    <p data-testid="rename-state" className="app-footnote">{settled} updates settled</p><p role="status">{message}</p></main>;
}
