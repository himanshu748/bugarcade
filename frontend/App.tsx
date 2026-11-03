import { useEffect, useRef, useState } from 'react';
import seeds from '../shared/challenges.json' with { type: 'json' };
import type { Action, Challenge, Health, Job } from './types';
import { actionLabel, request, terminalStates } from './types';
import { PUBLIC_DEMO, apiUrl, loadHostedCartridge } from './public-demo';
import { HostedWorkflow } from './HostedWorkflow';
import { Icon } from './icons';
import { ChallengeStages } from './ChallengeStages';
import { LandingPage } from './LandingPage';
import { SiteHeader } from './SiteHeader';
import { CaseProgressRail, CaseReward, useArcadeProgress } from './ArcadeProgress';
import { InvestigationProof, evidenceExpectation } from './InvestigationProof';
import { validateJobEvidence } from './job-evidence';
import type { JobEvidence } from './job-evidence';

const challenges = seeds as Challenge[];
const number = (index: number) => String(index + 1).padStart(2, '0');
const summaries: Record<string, string> = { 'lost-note': 'The disappearing note', rollback: 'The undo that went too far', search: 'The search stuck in the past', duplicate: 'The order placed twice', cleanup: 'The ghost of a page' };
const labels: Record<string, string> = { 'lost-note': 'State & closures', rollback: 'Optimistic updates', search: 'Async ordering', duplicate: 'Pending requests', cleanup: 'Effect lifecycle' };

function Brand({ compact = false }: { compact?: boolean }) { return <span className="brand"><span className="brand-mark"><Icon name="bug" size={23} /></span><span>BUG<span className="brand-light">ARCADE</span></span>{!compact && <span className="edition">VOL. 01</span>}</span>; }

interface FrameState { moves: number; ready: boolean; pending: unknown[]; assertionPassed: boolean | null; complete: boolean; error: string | null; replaying: boolean }
const emptyFrame: FrameState = { moves: 0, ready: false, pending: [], assertionPassed: null, complete: false, error: null, replaying: false };

function Arena({ challenge, onBack, jobId, jobMode = 'recorded' }: { challenge: Challenge; onBack: () => void; jobId?: string; jobMode?: 'live' | 'recorded' }) {
  const index = challenges.findIndex(c => c.id === challenge.id);
  const { cases, record } = useArcadeProgress();
  const progressKey = jobId ? `job:${jobId}` : `seed:${challenge.id}`;
  const attempt = useRef({ automatic: false, requestedReplay: false, replayStarted: false, bugAwarded: false, fixAwarded: false, invalid: false });
  const nextCases = jobId ? challenges : [...challenges.slice(index + 1), ...challenges.slice(0, index + 1)];
  const nextChallenge = nextCases.find(item => !cases[`seed:${item.id}`]?.fixedChecked)
    || nextCases.find(item => !cases[`seed:${item.id}`]?.targetMet) || nextCases[0];
  const iframe = useRef<HTMLIFrameElement>(null);
  const [variant, setVariant] = useState<'buggy' | 'fixed'>('buggy');
  const [session, setSession] = useState(0);
  const [frame, setFrame] = useState<FrameState>(emptyFrame);
  const [revealed, setRevealed] = useState(false);
  const [hint, setHint] = useState(false);
  const [tab, setTab] = useState<'replay' | 'evidence'>('replay');
  const [loadError, setLoadError] = useState(false);
  const [pendingReplay, setPendingReplay] = useState(false);
  const [cartridge, setCartridge] = useState<{ key: string; html: string } | null>(null);
  const cartridgeKey = `${jobId || challenge.id}-${variant}-${session}`;
  const usesCartridge = Boolean(jobId) || PUBLIC_DEMO;
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!usesCartridge) return;
    const controller = new AbortController();
    setCartridge(null);
    const load = PUBLIC_DEMO && !jobId ? loadHostedCartridge(challenge.id, variant, controller.signal)
      : fetch(`/api/job-artifacts/${encodeURIComponent(jobId!)}/player-${variant}.html`, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('This job has no playable cartridge. Run a fresh verification to package one.');
        const html = await response.text();
        if (html.length > 8 * 1024 * 1024) throw new Error('Cartridge exceeded its size limit.');
        return html;
      });
    load.then(html => { if (!controller.signal.aborted) setCartridge({ key: cartridgeKey, html }); })
      .catch(error => { if (!controller.signal.aborted) setFrame(previous => ({ ...previous, error: error.message })); });
    return () => controller.abort();
  }, [jobId, challenge.id, variant, session, cartridgeKey, usesCartridge]);
  useEffect(() => {
    let becameReady = false;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const d = event.data;
      if (d.type !== 'bugarcade:state' || d.challengeId !== challenge.id || d.variant !== variant) return;
      if (usesCartridge && cartridge?.key !== cartridgeKey) return;
      if (attempt.current.invalid) return;
      if (d.error) {
        attempt.current.invalid = true;
        attempt.current.requestedReplay = false;
        if (replayTimer.current) { clearTimeout(replayTimer.current); replayTimer.current = null; }
        setPendingReplay(false);
        setFrame(previous => ({ ...previous, replaying: false, error: typeof d.error === 'string' ? d.error.slice(0, 400) : 'The app reported an error. Reset the challenge and try again.' }));
        return;
      }
      // These are personal play milestones. Worker evidence remains the verifier record.
      if (d.replaying === true) attempt.current.automatic = true;
      if (d.ready === true && d.moves === 0 && d.completed !== true && d.replaying !== true && !attempt.current.requestedReplay) {
        attempt.current = { automatic: false, requestedReplay: false, replayStarted: false, bugAwarded: false, fixAwarded: false, invalid: false };
      }
      // App DOM can settle before the network rack observes its release. Score only after
      // the captured schedule's release acknowledgements are reflected in the action trace.
      const releases = Array.isArray(d.actions) ? d.actions.filter((action: Action) => action?.type === 'release').map((action: { request: string }) => action.request) : [];
      const scheduleSettled = challenge.actions.filter(action => action.type === 'release').every(action => releases.includes(action.request));
      const finished = typeof d.assertionPassed === 'boolean' && scheduleSettled && d.ready === true && d.completed === true && d.replaying !== true && !d.error && Number.isInteger(d.moves) && d.moves > 0 && d.moves <= 1000;
      if (finished) {
        if (replayTimer.current) { clearTimeout(replayTimer.current); replayTimer.current = null; }
        if (variant === 'buggy' && d.assertionPassed === false && !attempt.current.automatic && !attempt.current.requestedReplay && !attempt.current.bugAwarded) {
          attempt.current.bugAwarded = true;
          record(progressKey, { type: 'bug', moves: d.moves, target: challenge.targetMoves });
        }
        if (variant === 'fixed' && d.assertionPassed === true && attempt.current.requestedReplay && attempt.current.replayStarted && !attempt.current.fixAwarded) {
          attempt.current.fixAwarded = true;
          record(progressKey, { type: 'fixed' });
        }
        attempt.current.requestedReplay = false;
      }
      becameReady = d.ready === true;
      setLoadError(false);

      setFrame(previous => ({ moves: typeof d.moves === 'number' && d.moves >= 0 && d.moves <= 1000 ? d.moves : previous.moves, ready: d.ready === true, pending: Array.isArray(d.pending) ? d.pending.slice(0, 12) : [], assertionPassed: typeof d.assertionPassed === 'boolean' ? d.assertionPassed : null, complete: d.completed === true, error: typeof d.error === 'string' ? d.error.slice(0, 400) : null, replaying: d.replaying === true }));
    };
    window.addEventListener('message', onMessage);
    const timeout = setTimeout(() => { if (!becameReady) { attempt.current.invalid = true; setLoadError(true); } }, 12000);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timeout); };
  }, [challenge.id, challenge.targetMoves, challenge.actions, session, variant, jobId, cartridge?.key, cartridgeKey, usesCartridge, progressKey, record]);
  useEffect(() => { if (frame.ready) setLoadError(false); }, [frame.ready]);
  useEffect(() => {
    if (!pendingReplay) return;
    const timeout = setTimeout(() => {
      attempt.current.invalid = true;
      setPendingReplay(false);
      setFrame(previous => ({ ...previous, replaying: false, error: 'The app did not become ready. Reset the challenge and try again.' }));
    }, 12000);
    return () => clearTimeout(timeout);
  }, [pendingReplay]);
  useEffect(() => {
    if (!pendingReplay || !frame.ready) return;
    attempt.current.replayStarted = true;
    iframe.current?.contentWindow?.postMessage({ type: 'bugarcade:replay', actions: challenge.actions }, '*');
    setPendingReplay(false);
    setFrame(previous => ({ ...previous, replaying: true }));
    replayTimer.current = setTimeout(() => { attempt.current.invalid = true; setFrame(previous => ({ ...previous, replaying: false, error: 'Replay exceeded its time limit. Reset the app and try again.' })); }, 30000);
  }, [pendingReplay, frame.ready, challenge.actions]);
  useEffect(() => () => { if (replayTimer.current) clearTimeout(replayTimer.current); }, []);
  const reset = (nextVariant = variant) => { if (nextVariant !== variant) iframe.current?.closest('.app-window')?.scrollIntoView({ behavior: 'instant', block: 'start' }); if (replayTimer.current) clearTimeout(replayTimer.current); attempt.current = { automatic: false, requestedReplay: false, replayStarted: false, bugAwarded: false, fixAwarded: false, invalid: false }; setPendingReplay(false); setVariant(nextVariant); setFrame(emptyFrame); setLoadError(false); setSession(s => s + 1); };
  const replay = (nextVariant = variant) => {
    // Bring the observed app into view; offscreen embedded browsers can pause animation frames used by readiness.
    iframe.current?.closest('.app-window')?.scrollIntoView({ behavior: 'instant', block: 'start' });
    reset(nextVariant); attempt.current.requestedReplay = true; attempt.current.automatic = true; setPendingReplay(true);
  };
  const replayBusy = pendingReplay || frame.replaying || (!attempt.current.invalid && attempt.current.requestedReplay);
  const reveal = () => { setRevealed(true); setTimeout(() => revealRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }), 30); };
  return <>
    <nav className="arena-breadcrumb arena-player-breadcrumb" aria-label="Challenge navigation"><button className="text-button" onClick={onBack}><Icon name="back" size={16}/> All challenges</button><span>{jobId ? 'Created challenge' : `Case ${number(index)}`} / {jobId ? 'Browser cartridge' : labels[challenge.id]}</span></nav>
    <header className="arena-heading arena-player-heading"><div><h1>{jobId ? challenge.title : summaries[challenge.id] || challenge.title}</h1><p>{challenge.goal}</p></div><div className="moves" aria-live="polite" aria-atomic="true"><b key={frame.moves} className={`move-count ${frame.moves > 0 ? 'is-updated' : ''}`}>{String(frame.moves).padStart(2, '0')}</b><span>Moves<strong>{challenge.targetMoves} to aim for</strong></span></div></header>
    <ChallengeStages active={!revealed ? 'play' : tab === 'evidence' ? 'evidence' : 'reveal'}/>
    <div className="arena-grid arena-player-workspace">
      <section className="app-window" data-variant={variant} aria-label="Playable challenge">
        <div className="window-toolbar"><span className="mono">{challenge.id}.app</span><span className={`variant-label ${variant}`}>{variant === 'buggy' ? 'Buggy build' : 'Fixed build'}</span><button aria-label="Reset challenge" className="icon-button arena-reset" onClick={() => reset()}><Icon name="reset" size={16}/><span>Reset</span></button></div>
        <iframe ref={iframe} key={`${variant}-${session}`} onLoad={() => { if (usesCartridge) iframe.current?.contentWindow?.postMessage({ type: 'bugarcade:bind-parent' }, '*'); }} title={`${challenge.title} playable app`} srcDoc={usesCartridge && cartridge?.key === cartridgeKey ? cartridge.html : undefined} src={usesCartridge ? undefined : `http://127.0.0.1:4174/fixture/${encodeURIComponent(challenge.id)}/${variant}?reset=${session}&parentOrigin=${encodeURIComponent(location.origin)}`} sandbox="allow-scripts" referrerPolicy="no-referrer"/>
        <div className="app-status" role="status">{frame.error || (loadError ? (usesCartridge ? 'Cartridge did not start. Reset or inspect the run evidence.' : 'App unavailable. Start the fixture server, then reset.') : frame.replaying ? 'Replaying the recorded actions…' : frame.ready ? frame.complete && frame.assertionPassed !== null ? frame.assertionPassed ? 'This play session passed the check. Captured verification is available below.' : 'Bug triggered. Reveal the replay to see why.' : variant === 'fixed' ? 'Fixed build ready. Run the same actions to check it.' : 'Ready to break. Every action happens in the real app.' : 'Starting the app…')}</div>
      </section>
      <aside className="mission arena-player-guidance" aria-label="Challenge guidance">
        <h2>How to play</h2><p>Try to trigger the bug described above. You don’t need to edit any code.</p>
        <h3 className="mission-rules-title">You control the timing</h3><ol className="house-rules"><li>Click or type in the app to explore what goes wrong.</li><li>The network controls below the app show waiting API responses. Use Release to deliver one when you choose.</li><li>Reset starts over, without a penalty. Reveal shows the solution.</li></ol>
        <button className="hint-button" aria-expanded={hint} onClick={() => setHint(!hint)}><span>{hint ? 'Hide the hint' : 'A little nudge?'}</span><span>{hint ? '−' : '+'}</span></button>{hint && <p className="hint-copy">{challenge.hint}</p>}
        <button className="button secondary full" onClick={reveal}>Reveal the replay <Icon name="arrow"/></button><p className="tiny muted">Contains the solution. Curiosity is allowed.</p>
        <CaseProgressRail progressKey={progressKey} target={challenge.targetMoves}/>
      </aside>
    </div>
    {frame.complete && !frame.replaying && frame.assertionPassed !== null && !frame.error && <div className={`outcome ${frame.assertionPassed === false ? 'failure' : 'success'}`} role="status"><Icon name={frame.assertionPassed === false ? 'bug' : 'check'}/><div><strong>{frame.assertionPassed === false ? 'There it is. You broke the app.' : 'The app kept its promise.'}</strong><p>{frame.assertionPassed === false ? 'The expected state and observed state disagree. Reveal the sequence to see why.' : 'The intended assertion holds for these actions.'}</p></div>{!revealed && <button className="button secondary" onClick={reveal}>See what happened <Icon name="arrow"/></button>}</div>}
    <CaseReward progressKey={progressKey} next={nextChallenge} busy={replayBusy} onCheckFix={() => { setRevealed(true); setTab('replay'); replay('fixed'); }} onRetry={() => reset('buggy')}/>
    {revealed && <section className="reveal-section arena-player-reveal" ref={revealRef}>
      <div className="section-heading"><h2>Same moves. Different ending.</h2><span className="recorded-tag">{jobId ? 'Packaged verified sequence' : 'Authored seed replay'}</span></div>
      <div className="reveal-tabs" role="tablist" aria-label="Challenge details" onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'replay' : event.key === 'End' ? 'evidence' : tab === 'replay' ? 'evidence' : 'replay'; setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}><button id="tab-replay" aria-controls="detail-panel" role="tab" tabIndex={tab === 'replay' ? 0 : -1} aria-selected={tab === 'replay'} onClick={() => setTab('replay')}>The replay</button><button id="tab-evidence" aria-controls="detail-panel" role="tab" tabIndex={tab === 'evidence' ? 0 : -1} aria-selected={tab === 'evidence'} onClick={() => setTab('evidence')}>The evidence</button></div>
      {tab === 'replay' ? <div id="detail-panel" className="reveal-grid motion-panel" role="tabpanel" aria-labelledby="tab-replay"><div><h3>The sequence</h3><ol className="action-timeline">{challenge.actions.map((action: Action, i: number) => <li key={i}><span>{number(i)}</span><div><b>{actionLabel(action)}</b><small>{action.type === 'release' ? 'Controlled API response' : action.type === 'wait' ? 'Observable checkpoint' : 'Browser interaction'}</small></div></li>)}</ol></div><div className="explanation"><h3>What went wrong</h3><p>{challenge.explanation}</p><div className="assertion-card"><span>The promise</span><code>{challenge.assertion.target} {challenge.assertion.operator} {JSON.stringify(challenge.assertion.expected)}</code></div><div className="replay-controls"><div className="segmented" data-variant={variant} aria-label="App version"><button aria-pressed={variant === 'buggy'} className={variant === 'buggy' ? 'active buggy' : ''} onClick={() => reset('buggy')}>Buggy</button><button aria-pressed={variant === 'fixed'} className={variant === 'fixed' ? 'active fixed' : ''} onClick={() => reset('fixed')}>Fixed</button></div><button className="button primary" disabled={replayBusy} onClick={() => replay()}><Icon name="play" size={14}/>{replayBusy ? 'Replaying…' : 'Run same actions'}</button></div><p className="tiny muted">Replays reset the app first. The assertion stays the same.</p></div></div> : <Evidence challenge={challenge} jobId={jobId} jobMode={jobMode}/>}
    </section>}
  </>;
}

function Evidence({ challenge, jobId, jobMode }: { challenge: Challenge; jobId?: string; jobMode: 'live' | 'recorded' }) {
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [checkedJob, setCheckedJob] = useState<JobEvidence | null>(null);
  const [error, setError] = useState('');
  const [evidenceAttempt, setEvidenceAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setEvidence(null); setCheckedJob(null); setError('');
    const timer = setTimeout(() => { controller.abort(); setError('Captured evidence request timed out. Retry to load the saved record.'); }, 12000);
    request<Record<string, unknown>>(jobId ? `/api/job-artifacts/${jobId}/summary.json` : `/api/challenges/${challenge.id}/evidence`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      if (jobId) {
        const checked = validateJobEvidence(data, evidenceExpectation(challenge, jobId, jobMode));
        setCheckedJob(checked);
        setEvidence({ ...data, mode: checked.mode, runner: checked.runner, modelCalls: checked.modelCalls,
          browserVersion: checked.browserVersion, elapsedMs: checked.elapsedMs,
          initialActionCount: checked.initialActions.length, minimizedActionCount: checked.actions.length,
          repetitions: { buggy: checked.validationRuns.filter(run => run.variant === 'buggy').map(run => ({ status: run.passed ? 'passed' : 'failed' })),
            fixed: checked.validationRuns.filter(run => run.variant === 'fixed').map(run => ({ status: run.passed ? 'passed' : 'failed' })) } });
      } else setEvidence(data);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [challenge, jobId, jobMode, evidenceAttempt]);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const repetition = evidence?.repetitions as { buggy?: { status: string }[]; fixed?: { status: string }[] } | undefined;
  const buggyRuns = repetition?.buggy ?? [], fixedRuns = repetition?.fixed ?? [];
  useJobPolling(job, setJob, setError);
  const artifactBase = jobId ? `/api/job-artifacts/${jobId}` : `/api/artifacts/${challenge.id}`;
  const verify = async () => { setBusy(true); setError(''); try { setJob(await request<Job>('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.id, mode: 'recorded', idempotencyKey: crypto.randomUUID() }) })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div id="detail-panel" className="evidence-panel motion-panel" role="tabpanel" aria-labelledby="tab-evidence"><div className="evidence-intro"><div><h3>Proof you can inspect.</h3><p>Captured browser runs. A deterministic assertion decides the result.</p></div>{!jobId && !PUBLIC_DEMO && <button className="button secondary" onClick={verify} disabled={busy || Boolean(job && !terminalStates.has(job.state))}><Icon name="reset"/>{busy || (job && !terminalStates.has(job.state)) ? 'Verification running…' : 'Verify again locally'}</button>}</div>{error && <><p className="error-message" role="alert">{error}</p><button className="text-button" onClick={() => setEvidenceAttempt(value => value + 1)}>Reload captured evidence <Icon name="reset" size={14}/></button></>}{job && <JobProgress job={job} onCancel={async () => { setJob(await request<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' })); }}/>} {evidence ? <><div className="verification-grid"><div><span>BUGGY · ASSERTION FAILURES</span><strong>{buggyRuns.filter(r => r.status === "failed").length}<small> / {buggyRuns.length}</small></strong></div><div><span>FIXED · ASSERTION PASSES</span><strong>{fixedRuns.filter(r => r.status === "passed").length}<small> / {fixedRuns.length}</small></strong></div><div><span>ACTIONS · INITIAL → MINIMIZED</span><strong>{String(evidence.initialActionCount ?? "—")}<small> → </small>{String(evidence.minimizedActionCount ?? "—")}</strong></div></div><div className="evidence-badges"><span><Icon name="file"/> Captured evidence</span><span>{evidence.runner === 'modal-sandbox' ? 'MODAL SANDBOX' : 'LOCAL RUNNER'}</span><span>{evidence.mode === 'live' ? 'LIVE MODEL PROPOSALS' : 'NO MODEL CALLS'}</span></div><p className="tiny muted">Chromium {String(evidence.browserVersion ?? "unknown")} · {typeof evidence.elapsedMs === "number" ? (evidence.elapsedMs / 1000).toFixed(1) : "—"}s verification · {String(evidence.modelCalls ?? 0)} live model {evidence.modelCalls === 1 ? 'call' : 'calls'}</p><p className="evidence-limit">Three buggy failures and three fixed passes under one schedule establish repeatability for that schedule, not broad reliability.</p><div className="artifact-links"><a className="button secondary" href={apiUrl(`${artifactBase}/regression.test.mjs`)} download><Icon name="download"/> Regression test</a><a className="button secondary" href={apiUrl(`${artifactBase}/summary.json`)} download><Icon name="file"/> Evidence JSON</a><a className="button secondary" href={apiUrl(`${artifactBase}/${jobId ? 'buggy-trace.zip' : 'buggy-1/trace.zip'}`)} download><Icon name="download"/> Buggy trace</a><a className="button secondary" href={apiUrl(`${artifactBase}/${jobId ? 'fixed-trace.zip' : 'fixed-1/trace.zip'}`)} download><Icon name="download"/> Fixed trace</a><a className="button secondary" href={apiUrl(`${artifactBase}/${jobId ? 'buggy-recording.webm' : 'buggy-1/recording.webm'}`)} download><Icon name="play"/> Captured recording</a></div>{checkedJob && jobId && <InvestigationProof data={checkedJob} jobId={jobId}/>}<details className="raw-evidence"><summary>Inspect hashes, schedule, assertions and run results</summary><pre>{JSON.stringify(evidence, null, 2)}</pre></details></> : !error && <p className="muted" role="status">Loading recorded evidence…</p>}</div>;
}

function useJobPolling(job: Job | null, setJob: (job: Job) => void, setError: (error: string) => void) {
  useEffect(() => {
    if (!job || terminalStates.has(job.state)) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setInterval(() => { request<Job>(`/api/jobs/${job.id}`, { signal: controller.signal }).then(next => { if (!cancelled) setJob(next); }).catch(error => { if (!cancelled) setError(error.message); }); }, 900);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [job, setJob, setError]);
}

function JobProgress({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const terminal = terminalStates.has(job.state);
  return <section className="job-progress" data-running={!terminal} aria-label="Job progress"><div className="job-heading"><span className={`state-pill state-${job.state}`} role="status">{job.state.replaceAll('-', ' ')}</span><code>{job.id.slice(0, 8)}</code>{!terminal && <button className="text-button" onClick={onCancel}>Cancel run <Icon name="close" size={14}/></button>}</div><ol>{job.events.map((event, i) => <li key={i}><span className="event-dot"/><div><strong>{event.state.replaceAll('-', ' ')}</strong><p>{event.message}</p></div></li>)}</ol>{job.error && <p className="error-message" role="alert">{typeof job.error === 'string' ? job.error : job.error.message}</p>}{job.state === 'completed' && <div className="artifact-links"><a className="button secondary" href={`/api/job-artifacts/${job.id}/regression.test.mjs`} download><Icon name="download"/> Regression test</a><a className="button secondary" href={`/api/job-artifacts/${job.id}/summary.json`} download><Icon name="file"/> Run evidence</a><a className="button secondary" href={`/api/job-artifacts/${job.id}/challenge.json`} download><Icon name="file"/> Challenge package</a><a className="button secondary" href={`/api/job-artifacts/${job.id}/source.zip`} download><Icon name="download"/> Starter source</a><a className="button primary" href={`#job/${job.id}`}>Play created challenge <Icon name="play" size={14}/></a></div>}{job.result && <details><summary>Inspect run result and provenance</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details>}{job.state === 'not-reproduced' && <p>No valid reproduction was found within this run’s bounds. No verified challenge was created.</p>}</section>;
}

function Create({ health, onBack }: { health: Health | null; onBack: () => void }) {
  const [mode, setMode] = useState<'recorded' | 'live'>('recorded');
  const [project, setProject] = useState<File | null>(null);
  const [recording, setRecording] = useState<File | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [hints, setHints] = useState('');
  const [uploaded, setUploaded] = useState<{ id: string; recording: { durationSeconds: number; frames: unknown[] } } | null>(null);
  const [seed, setSeed] = useState('lost-note');
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestKey = useRef<string | null>(null);
  useEffect(() => {
    const saved = sessionStorage.getItem('bugarcade:last-job');
    if (!saved) return;
    const controller = new AbortController();
    request<Job>(`/api/jobs/${encodeURIComponent(saved)}`, { signal: controller.signal }).then(setJob).catch(() => { if (!controller.signal.aborted) sessionStorage.removeItem('bugarcade:last-job'); });
    return () => controller.abort();
  }, []);
  useEffect(() => { if (job) sessionStorage.setItem('bugarcade:last-job', job.id); }, [job]);
  useJobPolling(job, setJob, setError);
  const validateFiles = async () => {
    if (!project || !recording || !authorized) throw new Error('Add both files and confirm authorization.');
    const form = new FormData(); form.append('project', project); form.append('recording', recording); form.append('hints', hints); form.append('authorized', 'true');
    const result = await request<{ id: string; recording: { durationSeconds: number; frames: unknown[] } }>('/api/projects', { method: 'POST', body: form });
    setUploaded(result);
    return result.id;
  };
  const inspectFiles = async () => {
    setBusy(true); setError('');
    try { await validateFiles(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      let projectId: string | undefined;
      if (mode === 'live' && project) {
        if (!recording || !authorized) throw new Error('Add a recording and confirm that you are authorized to execute this source.');
        projectId = uploaded?.id || await validateFiles();
      }
      requestKey.current ??= crypto.randomUUID();
      const result = await request<Job>('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(projectId ? { projectId } : { challengeId: seed }), mode, idempotencyKey: requestKey.current }) });
      setJob(result); requestKey.current = null;
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const running = busy || Boolean(job && !terminalStates.has(job.state));
  return <><div className="arena-breadcrumb"><button className="text-button" onClick={onBack}><Icon name="back" size={16}/> Back to arcade</button><span>CHALLENGE LAB</span></div><div className="create-heading"><div className="eyebrow">FROM “IT BROKE” TO “HERE’S PROOF”</div><h1>Give your bug a stage.</h1><p>A small app. A short recording. A reproduction you can actually run.</p></div><div className="create-grid"><form onSubmit={submit} className="create-form"><fieldset disabled={running}><legend>01 <span>Choose a run mode</span></legend><div className="mode-options"><label className={mode === 'recorded' ? 'selected' : ''}><input type="radio" name="mode" value="recorded" checked={mode === 'recorded'} onChange={() => setMode('recorded')}/><span><b>Recorded demo</b><small>Re-verify an authored seed plan locally. No credentials or model calls.</small></span></label><label className={mode === 'live' ? 'selected' : ''}><input type="radio" name="mode" value="live" checked={mode === 'live'} onChange={() => setMode('live')}/><span><b>Live agent <span className="inline-tag">BUDGET GATED</span></b><small>Muse Spark Open proposes actions. Modal executes submitted apps.</small></span></label></div>{mode === 'recorded' ? <div className="field"><label htmlFor="seed">Choose the seed to verify</label><select id="seed" value={seed} onChange={e => setSeed(e.target.value)}>{challenges.map(c => <option key={c.id} value={c.id}>{summaries[c.id]}</option>)}</select></div> : <><div className="live-notice" role="status"><Icon name="bolt"/><div><b>{health?.liveEnabled ? 'Live execution enabled by the operator' : 'Live execution is disabled'}</b><p>Requires existing provider credentials, a prebuilt sandbox image and an explicitly approved budget.</p><p>Model provider: {health?.modelProvider === 'modal' ? 'Modal Shared Endpoint' : health?.modelProvider === 'baseten' ? 'Baseten' : 'checking configuration…'}{health?.modelConfigured === false ? ' · access not configured' : ''}</p>{!health?.liveEnabled && <details><summary>Operator setup requirements</summary><ul>{(health?.liveDisabledReasons || ['Start the backend to check availability.']).map(reason => <li key={reason}>{reason}</li>)}</ul></details>}</div></div><legend className="step-legend">02 <span>Add your evidence</span></legend><div className="upload-grid"><label className="upload-field"><Icon name="code" size={25}/><b>Authorized app source</b><small>Starter v1 ZIP · buggy + fixed source</small><input type="file" accept=".zip,application/zip" onChange={e => { setUploaded(null); setProject(e.target.files?.[0] || null); }}/><span>{project?.name || 'Choose ZIP file'}</span></label><label className="upload-field"><Icon name="play" size={25}/><b>A short bug recording</b><small>MP4 or WebM · max 30 seconds</small><input type="file" accept="video/mp4,video/webm" onChange={e => { setUploaded(null); setRecording(e.target.files?.[0] || null); }}/><span>{recording?.name || 'Choose recording'}</span></label></div><div className="field"><label htmlFor="hints">Reproduction hints <span className="muted">(optional)</span></label><textarea id="hints" maxLength={2000} rows={3} placeholder="What did you expect, and what happened instead?" value={hints} onChange={e => { setUploaded(null); setHints(e.target.value); }}/></div><label className="checkbox-label"><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)}/><span>I own this source or have explicit permission to execute it and send its source and recording frames to the configured model provider.</span></label><button className="button secondary full" type="button" disabled={running || !project || !recording || !authorized} onClick={inspectFiles}>{busy ? 'Validating…' : 'Validate files locally'}<Icon name="check"/></button>{uploaded && <div className="validated-input" role="status"><Icon name="check"/><p><strong>Starter and recording validated.</strong><br/>{uploaded.recording.frames.length} timestamped frames extracted. App code has not executed; no model or cloud call was made.</p></div>}</>}{error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full large" type="submit" disabled={running || (mode === 'live' && (!health?.liveEnabled || !project || !recording || !authorized))}>{busy ? 'Preparing…' : running ? 'Run in progress…' : mode === 'recorded' ? 'Run the recorded demo' : 'Investigate the bug'}<Icon name="arrow"/></button></fieldset></form><aside className="create-sidebar"><span className="eyebrow">A DELIBERATELY SMALL SURFACE</span><h2>Bring the starter.<br/>Keep the real bug.</h2><p>BugArcade supports small React/TypeScript apps through one documented interface.</p><pre className="file-tree">{`your-app.zip\n├─ manifest.json\n├─ buggy/App.tsx\n└─ fixed/App.tsx`}</pre><ul><li>React-only imports and <code>api.request()</code>.</li><li>Stable test IDs and a declared invariant.</li><li>Your fixed counterpart is required.</li><li>No package installs or repository scripts.</li></ul><a href="/api/starter" className="text-link" download>Download the starter <Icon name="download" size={16}/></a><div className="sidebar-note"><Icon name="file"/><p>A recording is a clue, not proof. Only executed browser actions and a deterministic assertion can verify a challenge.</p></div><p className="tiny muted">Live execution requires operator setup and approval. Credits are not a hard spending cap. The local runner is for shipped seeds only.</p></aside></div>{job && <JobProgress job={job} onCancel={async () => { try { setJob(await request<Job>(`/api/jobs/${job.id}/cancel`, { method: 'POST' })); } catch (e) { setError((e as Error).message); } }}/>}</>;
}


function CreatedChallenge({ id, onBack }: { id: string; onBack: () => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  useJobPolling(job, setJob, setError);
  useEffect(() => {
    const controller = new AbortController();
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal }).then(setJob)
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (job?.state !== 'completed') return;
    const controller = new AbortController();
    request<Challenge & { challengeId: string }>(`/api/job-artifacts/${encodeURIComponent(id)}/challenge.json`, { signal: controller.signal }).then(data => {
      if (!data.challengeId || !data.title || !Array.isArray(data.actions) || !data.assertion) throw new Error('The challenge package is invalid.');
      setChallenge({ ...data, id: data.challengeId, targetMoves: data.actions.filter(action => action.type !== 'wait').length, initialActions: data.actions, category: 'Created challenge', difficulty: 'Custom', subtitle: data.goal, accent: 'lime' });
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id, job?.state]);
  if (!challenge && job && job.state !== 'completed') {
    const title = job.state === 'failed' ? 'Investigation stopped.' : job.state === 'not-reproduced' ? 'Not reproduced.' : job.state === 'cancelled' ? 'Investigation cancelled.' : 'Your bug is under investigation.';
    return <><div className="create-heading"><div className="eyebrow">CHALLENGE LAB · RUN RECORD</div><h1>{title}</h1><p>{terminalStates.has(job.state) ? 'No verified challenge was created. The run record explains what happened.' : 'Watch the real job progress. A challenge is created only after verification.'}</p><button className="button secondary" onClick={onBack}>Back to arcade</button></div>{error && <p className="error-message" role="alert">{error}</p>}<JobProgress job={job} onCancel={async () => { try { setJob(await request<Job>(`/api/jobs/${id}/cancel`, { method: 'POST' })); } catch (e) { setError((e as Error).message); } }}/>{Array.isArray(job.result?.provenance) && job.result.provenance.length > 0 && <a className="button secondary" href={`/api/job-artifacts/${id}/provenance.json`} download><Icon name="download"/> Download model provenance</a>}</>;
  }
  if (error) return <div className="create-heading"><h1>{job ? 'Cartridge unavailable.' : 'Run unavailable.'}</h1><p className="error-message" role="alert">{error}</p><button className="button secondary" onClick={onBack}>Back to arcade</button></div>;
  if (!challenge) return <p className="loading-cartridge" role="status">Loading the verified challenge package…</p>;
  return <><div className="cartridge-notice">PLAYABLE CARTRIDGE · Browser playback is for exploration. The captured worker assertions are the verification evidence.</div><Arena challenge={challenge} jobId={id} jobMode={job?.mode === 'live' ? 'live' : 'recorded'} onBack={onBack}/></>;
}

export default function App() {
  const parseRoute = () => location.hash.startsWith('#job/') ? { view: 'job', id: location.hash.slice(5) } : location.hash.startsWith('#play/') ? { view: 'arena', id: location.hash.slice(6) } : { view: location.hash === '#create' ? 'create' : 'gallery', id: '' };
  const [route, setRoute] = useState(parseRoute);
  const [health, setHealth] = useState<Health | null>(null);
  const previousRoute = useRef(route);
  useEffect(() => { const handler = () => setRoute(parseRoute()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => {
    const section = location.hash.slice(1);
    const navigated = previousRoute.current !== route;
    previousRoute.current = route;
    const focusAtNavigation = document.activeElement;
    const frame = requestAnimationFrame(() => {
      // Native anchor focus can happen before this frame. Respect a newer keyboard/user choice.
      if (document.activeElement !== focusAtNavigation && document.activeElement !== document.body) return;
      if (['about', 'challenges', 'proof', 'faq'].includes(section)) {
        const target = document.getElementById(section);
        if (target?.contains(document.activeElement)) return;
        target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
        target?.focus({ preventScroll: true });
      } else if (navigated) { window.scrollTo({ top: 0, behavior: 'instant' }); document.getElementById('main')?.focus({ preventScroll: true }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [route]);
  useEffect(() => { if (PUBLIC_DEMO) return; const controller = new AbortController(); request<Health>('/api/health', { signal: controller.signal }).then(setHealth).catch(() => {}); return () => controller.abort(); }, []);
  const challenge = challenges.find(c => c.id === route.id);
  const goGallery = () => {
    location.hash = '';
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.getElementById('main')?.focus({ preventScroll: true });
  };
  return <div className="site-shell"><a href="#main" className="skip-link" onClick={e => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a><SiteHeader brand={<Brand/>} currentHash={location.hash} onHome={goGallery} onCreate={() => { location.hash = 'create'; }}/><main id="main" tabIndex={-1}>{PUBLIC_DEMO && (route.view === 'job' || route.view === 'create') ? <HostedWorkflow onBack={goGallery}/> : route.view === 'job' ? <CreatedChallenge key={route.id} id={route.id} onBack={goGallery}/> : route.view === 'create' ? <Create health={health} onBack={goGallery}/> : challenge ? <Arena key={challenge.id} challenge={challenge} onBack={goGallery}/> : <LandingPage challenges={challenges} summaries={summaries} categories={labels} onPlay={id => { location.hash = `play/${id}`; }} onCreate={() => { location.hash = 'create'; }}/>}</main><footer className="site-footer"><Brand compact/><span>BREAK IT. UNDERSTAND IT. PROVE IT.</span><span className="footer-mode"><span className="status-dot"/> {PUBLIC_DEMO ? 'PLAYABLE ARCADE · CAPTURED EVIDENCE' : route.view === 'job' ? 'CARTRIDGE PLAYBACK · SEE PROVENANCE' : 'LOCAL ARCADE · RECORDED SEEDS'}</span></footer></div>;
}
