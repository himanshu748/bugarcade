import { useEffect, useState } from 'react';

type Api = { request: (key: string, payload?: unknown) => Promise<unknown> };
function Details({ api, project, onLoad, onSettled }: { api: Api; project: string; onLoad: (title: string) => void; onSettled: () => void }) {
  useEffect(() => {
    let active = true;
    void api.request('project-' + project).then(data => { if (active) onLoad((data as { title: string }).title); }).finally(onSettled);
    return () => { active = false; };
  }, [api, project, onLoad, onSettled]);
  return <p className="app-footnote">Viewing project {project.toUpperCase()}</p>;
}
export default function App({ api }: { api: Api }) {
  const [project, setProject] = useState('a');
  const [title, setTitle] = useState('Loading project…');
  const [settled, setSettled] = useState(0);
  const [onSettled] = useState(() => () => setSettled(n => n + 1));
  return <main className="mini-app"><header><span className="app-icon">⌘</span><div><h1>Sidequest</h1><p>Keep your projects in view.</p></div></header>
    <nav className="project-tabs" aria-label="Projects"><button data-testid="nav-a" aria-pressed={project === 'a'} onClick={() => setProject('a')}>Project A</button><button data-testid="nav-b" aria-pressed={project === 'b'} onClick={() => setProject('b')}>Project B</button></nav>
    <div className="board-preview"><span className="eyebrow">PROJECT DETAILS</span><h2 data-testid="project-title">{title}</h2><Details key={project} api={api} project={project} onLoad={setTitle} onSettled={onSettled}/></div>
    <p data-testid="load-state" className="app-footnote">{settled} loads settled</p></main>;
}
