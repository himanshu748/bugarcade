import { useEffect, useRef, useState } from 'react';
import type { Challenge } from './types';
import { actionLabel, request } from './types';
import { Icon } from './icons';
import { ArcadePassport, CaseBadge } from './ArcadeProgress';
import { MetaCaptureLink } from './InvestigationProof';
import { validateSeedEvidence } from './seed-evidence';
import type { SeedEvidence } from './seed-evidence';

interface Props {
  challenges: Challenge[];
  summaries: Record<string, string>;
  categories: Record<string, string>;
  onPlay: (id: string) => void;
  onCreate: () => void;
}
type EvidenceState = { data: SeedEvidence | null; error: string; loading: boolean };
type TourStep = 'play' | 'reveal' | 'verify';
const tourSteps: { id: TourStep; title: string; detail: string; icon: 'play' | 'code' | 'check' }[] = [
  { id: 'play', title: 'Play the app', detail: 'Try to trigger a real bug.', icon: 'play' },
  { id: 'reveal', title: 'Reveal the cause', detail: 'See the steps and why it broke.', icon: 'code' },
  { id: 'verify', title: 'Test the fix', detail: 'Same steps. Check that the bug is gone.', icon: 'check' },
];

function EvidenceStatus({ evidence, retry }: { evidence: EvidenceState; retry: () => void }) {
  if (evidence.loading) return <p className="lp-proof-loading" role="status">Loading the captured verification…</p>;
  if (evidence.error || !evidence.data) return <div className="lp-proof-error" role="status"><Icon name="file"/><p>Captured evidence is unavailable.<small>{evidence.error || 'No verified record was returned.'}</small></p><button className="text-button" onClick={retry}>Retry evidence <Icon name="reset" size={14}/></button></div>;
  const { data } = evidence;
  return <div className="lp-assertion-result">
    <div className="lp-result-heading"><Icon name="file" size={16}/><span>Captured assertion results</span><span className="lp-recorded-label">Known seed</span></div>
    <div className="lp-result-rule"><span>The invariant</span><code>{data.assertion.target} {data.assertion.operator} {JSON.stringify(data.assertion.expected)}</code></div>
    <div className="lp-result-line lp-result-fail"><span>Buggy build</span><strong>{data.buggyFailures} / 3 <small>failures</small></strong><Icon name="close"/></div>
    <div className="lp-result-line lp-result-pass"><span>Fixed build</span><strong>{data.fixedPasses} / 3 <small>passes</small></strong><Icon name="check"/></div>
    <div className="lp-result-foot"><span>One schedule. Same assertion.</span><span>Chromium {data.browserVersion}</span></div>
  </div>;
}

function LocalPreview({ active, variant, onActivate }: { active: boolean; variant: 'buggy' | 'fixed'; onActivate: () => void }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState(0);
  const [state, setState] = useState({ moves: 0, ready: false, complete: false, passed: null as boolean | null, error: '' });
  useEffect(() => {
    if (!active) return;
    let ready = false;
    const listen = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const data = event.data;
      if (data.type !== 'bugarcade:state' || data.challengeId !== 'lost-note' || data.variant !== variant) return;
      ready = data.ready === true;
      setState(previous => ({ moves: typeof data.moves === 'number' && data.moves >= 0 && data.moves <= 1000 ? data.moves : previous.moves,
        ready, complete: data.completed === true, passed: typeof data.assertionPassed === 'boolean' ? data.assertionPassed : null,
        error: typeof data.error === 'string' ? data.error.slice(0, 400) : '' }));
    };
    window.addEventListener('message', listen);
    const timeout = setTimeout(() => { if (!ready) setState(previous => ({ ...previous, error: 'The preview did not start. Reset it to try again.' })); }, 12000);
    return () => { window.removeEventListener('message', listen); clearTimeout(timeout); };
  }, [active, variant, session]);
  const reset = () => { setState({ moves: 0, ready: false, complete: false, passed: null, error: '' }); setSession(value => value + 1); };
  return <div className="lp-preview" aria-label="Local playable preview">
    <div className="lp-preview-bar"><span>papertrail.app</span><span className={`lp-build-label ${variant}`}>{variant === 'buggy' ? 'BUGGY BUILD' : 'FIXED BUILD'}</span>{active && <button className="icon-button" aria-label="Reset inline preview" onClick={reset}><Icon name="reset" size={16}/></button>}</div>
    {active ? <iframe ref={iframe} key={`${variant}-${session}`} title={`Papertrail playable preview — ${variant}`}
      src={`http://127.0.0.1:4174/fixture/lost-note/${variant}?reset=${session}&parentOrigin=${encodeURIComponent(location.origin)}`}
      sandbox="allow-scripts" referrerPolicy="no-referrer"/> : <div className="lp-preview-cover"><img src="/product/lost-note.png" width="1280" height="1120" alt="Papertrail in its initial state, ready for your first move" loading="lazy"/><button className="button primary large" onClick={onActivate}><Icon name="play" size={16}/> Play here</button><p>A real app. No sign-in. No model calls.</p></div>}
    <div className="lp-preview-status" role="status"><span>{!active ? 'Your move, whenever you’re ready.' : state.error || (state.complete ? state.passed ? 'The note survived. Same moves, fixed build.' : 'There it is. The note disappeared.' : state.ready ? 'You control the app and when its response arrives.' : 'Starting the local app…')}</span>{active && <b>{String(state.moves).padStart(2, '0')} <span>MOVES</span></b>}</div>
  </div>;
}

function ProductTour({ challenge, evidence, retry, onPlay }: { challenge: Challenge; evidence: EvidenceState; retry: () => void; onPlay: () => void }) {
  const [step, setStep] = useState<TourStep>('play');
  const [active, setActive] = useState(false);
  const [variant, setVariant] = useState<'buggy' | 'fixed'>('buggy');
  const [videoError, setVideoError] = useState(false);
  const choose = (next: TourStep) => setStep(next);
  return <section id="about" tabIndex={-1} className="lp-tour lp-section" aria-labelledby="tour-title">
    <div className="lp-section-heading"><div><h2 id="tour-title">How BugArcade works.</h2></div><p>Play first. Reveal when you’re ready.<br/>Then check the fix with the same actions.</p></div>
    <div className="lp-tour-tabs" role="tablist" aria-label="Product walkthrough" onKeyDown={event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tourSteps.findIndex(value => value.id === step);
      const next = tourSteps[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3].id;
      choose(next); document.getElementById(`tour-tab-${next}`)?.focus();
    }}>{tourSteps.map((item, index) => <button key={item.id} id={`tour-tab-${item.id}`} role="tab" aria-selected={step === item.id} aria-controls="tour-panel" tabIndex={step === item.id ? 0 : -1} onClick={() => choose(item.id)}><span className="lp-tab-number">0{index + 1}</span><span><b>{item.title}</b><small>{item.detail}</small></span><Icon name={item.icon} size={19}/></button>)}</div>
    <div id="tour-panel" className={`lp-tour-panel lp-tour-${step}`} key={step} role="tabpanel" aria-labelledby={`tour-tab-${step}`}>
      <div className="lp-tour-copy">
        
        <h3>{step === 'play' ? <>Can you lose a note<br/>in three moves?</> : step === 'reveal' ? <>See what broke,<br/>and why.</> : <>Replay the bug.<br/>Check the fix.</>}</h3>
        <p>{step === 'play' ? 'Click Play here to use Papertrail, a small note-taking app with a real bug. Try to make a new note disappear. The network controls below the app let you decide when waiting responses arrive.' : step === 'reveal' ? 'This is the solution. Watch the captured browser recording, follow the actions and read why the note disappeared. You can repeat these steps in the playable app.' : 'The test checks that the new note survives. These saved browser runs show it failing on the buggy app and passing on the fixed app, with the same actions and response timing.'}</p>
        {step === 'play' && <><div className="lp-preview-version" aria-label="Preview build"><button aria-pressed={variant === 'buggy'} onClick={() => setVariant('buggy')}>Buggy</button><button aria-pressed={variant === 'fixed'} onClick={() => setVariant('fixed')}>Fixed</button></div><button className="text-link" onClick={onPlay}>Open the full challenge <Icon name="arrow" size={16}/></button><span className="lp-small-print">No answer spoilers until you choose Reveal.<br/>Changing builds or tour steps resets this preview.</span></>}
        {step === 'reveal' && <><ol className="lp-tour-sequence">{challenge.actions.map((action, index) => <li key={index}><span>0{index + 1}</span><b>{actionLabel(action)}</b></li>)}</ol><p className="lp-small-print">Authored seed plan · genuine local browser capture.<br/>Silent recording; the action list is its text alternative.</p></>}
        {step === 'verify' && <><button className="button primary" onClick={() => { setVariant('fixed'); setActive(true); choose('play'); }}>Try the fixed build <Icon name="arrow"/></button><p className="lp-small-print">Three repeats under one controlled schedule demonstrate repeatability for this case, not broad reliability.</p></>}
      </div>
      <div className="lp-tour-surface">
        {step === 'play' && <LocalPreview key={variant} active={active} variant={variant} onActivate={() => setActive(true)}/>}
        {step === 'reveal' && <div className="lp-recording"><div className="lp-recording-label">Captured reproduction <span>Local buggy build</span></div>{videoError ? <p className="lp-proof-error" role="status">This browser could not play the recording. <a href="/api/artifacts/lost-note/buggy-1/recording.webm" download>Download the captured video</a> or read the action sequence beside it.</p> : <video controls preload="none" poster="/api/artifacts/lost-note/buggy-1/final.png" onError={() => setVideoError(true)} aria-label="Captured lost-note bug reproduction"><source src="/api/artifacts/lost-note/buggy-1/recording.webm" type="video/webm"/></video>}<div className="lp-recording-explanation"><Icon name="code"/><p>{challenge.explanation}</p></div></div>}
        {step === 'verify' && <><EvidenceStatus evidence={evidence} retry={retry}/><div className="lp-tour-downloads"><a className="text-link" href="/api/artifacts/lost-note/regression.test.mjs" download>Get the regression test <Icon name="download" size={16}/></a><a className="text-link" href="/api/artifacts/lost-note/buggy-1/trace.zip" download>Inspect the browser trace <Icon name="external" size={16}/></a></div></>}
      </div>
    </div>
  </section>;
}

const questions = [
  { question: 'Is this a real bug, or a scripted animation?', answer: 'A real bug. The playable React app has a stale-state defect. Your clicks and controlled API responses change its actual state. The reveal includes a genuinely captured browser recording; it is labelled separately from your current play session.' },
  { question: 'What can I bring to the challenge lab?', answer: 'A small, explicitly authorized React/TypeScript app using Starter v1: buggy and fixed App.tsx files, stable test IDs, a declared assertion and a controlled API schedule. Bring a short MP4 or WebM recording too. Arbitrary repositories and dependency installation are outside the supported interface.' },
  { question: 'Where does the Meta model make decisions?', answer: 'Muse Spark Open inspects source and timestamped recording frames, then proposes browser actions. A real proposal through Modal drove the lost-note experiment: four actions reduced to three, three buggy failures and three fixed passes, then an exported test that failed buggy and passed fixed. The browser verifier decides the outcome. The five gallery cases use authored plans. General uploaded-app live execution remains disabled while memory-limit verification is incomplete; replaying captured evidence makes no new model calls.' },
  { question: 'Do I need credentials to play?', answer: 'No. The local seed arcade and recorded evidence need no model credentials. Submitted-app investigations require existing provider access, an immutable Modal image and an explicitly approved budget. No paid cloud execution is enabled here.' },
  { question: 'What exactly does “verified” mean?', answer: 'For each seed, the intended assertion failed three consecutive times on the buggy build and passed three times on the fixed build under the same controlled schedule. Exported regression tests were also checked. This is evidence for five known cases, not a claim that the agent generalizes to arbitrary bugs.' },
];

export function LandingPage({ challenges, summaries, categories, onPlay, onCreate }: Props) {
  const [evidence, setEvidence] = useState<EvidenceState>({ data: null, error: '', loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setEvidence({ data: null, error: '', loading: true });
    const deadline = setTimeout(() => {
      controller.abort();
      setEvidence({ data: null, error: 'Evidence request timed out. Try again.', loading: false });
    }, 12000);
    Promise.all([
      request<unknown>('/api/challenges/lost-note/evidence', { signal: controller.signal }),
      ...['buggy-1', 'buggy-2', 'buggy-3', 'fixed-1', 'fixed-2', 'fixed-3'].map(run => request<unknown>(`/api/artifacts/lost-note/${run}/result.json`, { signal: controller.signal })),
    ]).then(([summary, ...runs]) => validateSeedEvidence(summary, runs))
      .then(data => { if (!controller.signal.aborted) setEvidence({ data, error: '', loading: false }); })
      .catch(error => { if (!controller.signal.aborted) setEvidence({ data: null, error: (error as Error).message, loading: false }); })
      .finally(() => clearTimeout(deadline));
    return () => { clearTimeout(deadline); controller.abort(); };
  }, [attempt]);
  const lostNote = challenges.find(challenge => challenge.id === 'lost-note')!;
  const retry = () => setAttempt(value => value + 1);
  return <div className="landing">
    <section className="hero lp-hero" aria-labelledby="hero-title">
      <div className="intro-copy">
        <p className="lp-product-definition">A debugging game for React developers.</p>
        <h1 id="hero-title">Can you make<br/>this note disappear?</h1>
        <p className="hero-subtitle">Play a small React app, uncover its bug, then test the fix.</p>
        <div className="hero-actions"><button className="button primary large" onClick={() => onPlay('lost-note')}>Play the challenge <Icon name="play" size={16}/></button><a className="lp-hero-secondary" href="#about">See it in action <Icon name="play" size={16}/></a></div>
        <ol className="lp-play-overview" aria-label="How you play"><li><b>Play</b><span>Trigger the bug.</span></li><li><b>Reveal</b><span>See why it broke.</span></li><li><b>Check the fix</b><span>Replay the same moves.</span></li></ol>
        <div className="lp-hero-assurance"><span><Icon name="check" size={16}/> No sign-up</span><span><Icon name="check" size={16}/> No code to write</span></div>
      </div>
      <figure className="hero-product-shot"><button className="hero-visual lp-hero-cartridge" onClick={() => onPlay('lost-note')} aria-label="Open the lost-note challenge"><img src="/product/lost-note.png" width="1280" height="1120" alt="The actual Papertrail app, before the lost-note bug is triggered" fetchPriority="high"/></button><figcaption><strong>The lost note</strong><span>Play the app in your browser</span><Icon name="play" size={16}/></figcaption></figure>
    </section>
    <section id="challenges" tabIndex={-1} className="gallery lp-section" aria-labelledby="gallery-title">
      <div className="lp-section-heading"><div><h2 id="gallery-title">Choose a bug to play.</h2></div><p>Five small React apps, each with a real bug.<br/>Every challenge includes a replay, a fix and a test.</p></div>
      <ArcadePassport challenges={challenges} onPlay={onPlay}/>
      <div className="challenge-grid">{challenges.map((challenge, index) => <button className={`challenge-card card-${index}`} key={challenge.id} onClick={() => onPlay(challenge.id)}>
        <div className="card-top"><span className="case-word">Case</span><span>{String(index + 1).padStart(2, '0')}</span></div>
        <div className="artwork" aria-hidden="true"><img src={`/product/${challenge.id}.png`} width="1280" height="1120" alt="" loading="lazy"/></div>
        <div className="card-copy"><h3>{summaries[challenge.id] || challenge.title}</h3><span className="category">{categories[challenge.id]}</span><div className="card-bottom"><span>{challenge.targetMoves} moves</span></div><CaseBadge id={challenge.id}/></div><span className="card-arrow"><Icon name="arrow" size={20}/></span>
      </button>)}</div>
    </section>
    <ProductTour challenge={lostNote} evidence={evidence} retry={retry} onPlay={() => onPlay('lost-note')}/>
    <section id="proof" tabIndex={-1} className="lp-proof-section lp-section" aria-labelledby="proof-title">
      <div className="lp-proof-copy"><h2 id="proof-title">Take the replay.<br/>Keep the test.</h2><p>Download the browser replay and a regression test: an automated check that catches this bug if it comes back. The same check runs against both app versions.</p><details className="lp-proof-details"><summary>What was actually verified? <Icon name="plus" size={16}/></summary>{evidence.data ? <div><p>Three buggy failures and three fixed passes for the known lost-note seed, under one schedule. No live model call.</p><dl><dt>Invariant hash</dt><dd><code>{evidence.data.assertion.hash}</code></dd><dt>Buggy source</dt><dd><code>{evidence.data.sourceHashes.buggy}</code></dd><dt>Fixed source</dt><dd><code>{evidence.data.sourceHashes.fixed}</code></dd></dl></div> : <EvidenceStatus evidence={evidence} retry={retry}/>}</details></div>
      <div className="lp-artifacts"><a href="/api/artifacts/lost-note/regression.test.mjs" download><span className="lp-artifact-icon"><Icon name="code" size={24}/></span><span><b>The regression test</b><small>Executable check · requires the pinned worker</small></span><Icon name="download" size={20}/></a><a href="/api/artifacts/lost-note/buggy-1/trace.zip" download><span className="lp-artifact-icon"><Icon name="external" size={24}/></span><span><b>The browser trace</b><small>The actions, requests and observed state</small></span><Icon name="download" size={20}/></a><a href="/api/artifacts/lost-note/summary.json" download><span className="lp-artifact-icon"><Icon name="file" size={24}/></span><span><b>The evidence record</b><small>Source hashes, schedule and assertion results</small></span><Icon name="download" size={20}/></a></div>
      <MetaCaptureLink challenge={lostNote}/>
    </section>
    <section className="lp-create-section lp-section" aria-labelledby="create-title"><div className="lp-create-copy"><h2 id="create-title">Your bug deserves<br/>a better story.</h2><p>Bring a supported React app and a short recording. Turn the investigation into something someone else can play, inspect and run again.</p><button className="button primary" onClick={onCreate}>Create a challenge <Icon name="plus" size={16}/></button><p className="lp-small-print">Live-agent setup and budget approval required.<br/>The seed arcade is ready to play locally.</p></div><div className="lp-starter"><div className="lp-starter-header"><Icon name="code" size={20}/><span>Starter v1</span></div><pre>{`your-app.zip\n├─ manifest.json\n├─ buggy/App.tsx\n└─ fixed/App.tsx`}</pre><div className="lp-starter-notes"><span>React + TypeScript</span><span>Controlled API</span><span>Fixed counterpart</span></div><p>Small authorized apps. No arbitrary repositories,<br/>package installs or production accounts.</p><a href="/api/starter" className="text-link" download>Download Starter v1 <Icon name="download" size={16}/></a></div></section>
    <section id="faq" tabIndex={-1} className="lp-faq lp-section" aria-labelledby="faq-title"><div><h2 id="faq-title">Good questions.</h2><p>Clear boundaries. Better experiments.</p></div><div className="lp-faq-items">{questions.map(item => <details key={item.question}><summary>{item.question}<Icon name="plus" size={20}/></summary><p>{item.answer}</p></details>)}</div></section>
    <section className="lp-final-cta" aria-labelledby="last-call"><h2 id="last-call">Go on. Break something small.</h2><p>The first bug is three moves away.</p><a className="text-link" href="#challenges">Explore the cases <Icon name="arrow" size={16}/></a><button className="button primary large" onClick={() => onPlay('lost-note')}>Start with the lost note <Icon name="play" size={16}/></button><span className="lp-small-print lp-local-scope"><span>Local arcade</span><span>Real captured seed evidence</span><span>No model calls</span></span></section>
  </div>;
}
