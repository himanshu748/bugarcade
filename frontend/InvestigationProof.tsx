import { useEffect, useId, useState } from 'react';
import type { Action, Challenge, Job } from './types';
import { actionLabel, request } from './types';
import { Icon } from './icons';
import { validateJobEvidence } from './job-evidence';
import type { JobEvidence } from './job-evidence';

const capturedMetaJob = '6d18b3f942ea45698c972d6763ce3383';
const capturedMetaModel = 'workspace-endpoint-redacted.us-west.modal.direct';

export function evidenceExpectation(challenge: Challenge, jobId: string, mode: 'live' | 'recorded') {
  return { jobId, mode, challengeId: challenge.id, assertion: challenge.assertion,
    completion: challenge.completion, actions: challenge.actions, schedule: challenge.schedule };
}

function removedSteps(initial: Action[], minimized: Action[]) {
  const removed = new Set<number>();
  let next = 0;
  for (let index = 0; index < initial.length; index++) {
    if (next < minimized.length && JSON.stringify(initial[index]) === JSON.stringify(minimized[next])) next++;
    else removed.add(index);
  }
  return removed;
}

export function MetaCaptureLink({ challenge }: { challenge: Challenge }) {
  const [state, setState] = useState<{ data: JobEvidence | null; loading: boolean; error: string }>({ data: null, loading: true, error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { controller.abort(); setState({ data: null, loading: false, error: 'The captured investigation request timed out.' }); }
    }, 12000);
    setState({ data: null, loading: true, error: '' });
    request<Job>(`/api/jobs/${capturedMetaJob}`, { signal: controller.signal }).then(job => {
      if (job.id !== capturedMetaJob || job.mode !== 'live' || job.state !== 'completed') throw new Error('The selected capture is not a completed live investigation.');
      const data = validateJobEvidence(job.result, evidenceExpectation(challenge, capturedMetaJob, 'live'));
      if (data.proposal?.provider !== 'modal' || data.proposal.model !== capturedMetaModel
        || data.invariantHash !== '072beb8f5d60874ac281b2b3ae95148d9f2d46de456d55c8167751d4183c8951'
        || data.sourceHashes.buggy !== '3e3691816b35c455c4b6110de9dd8bd113ffe42abcdaf7714eea6818a099a882'
        || data.sourceHashes.fixed !== '734bd14d0e4b44db1d2356164ee1b813863c0a12152709a7412776fcafc0652b') {
        throw new Error('The selected capture does not match the reviewed Muse example.');
      }
      if (!controller.signal.aborted) setState({ data, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ data: null, loading: false, error: (error as Error).message });
    }).finally(() => { settled = true; clearTimeout(timer); });
    return () => { settled = true; clearTimeout(timer); controller.abort(); };
  }, [challenge, attempt]);
  if (state.loading) return <p className="capture-availability" role="status">Checking the local Meta investigation capture…</p>;
  if (!state.data) return <div className="capture-availability capture-unavailable"><Icon name="file" size={17}/><div><b>Captured Meta example unavailable here.</b><p>{state.error} The five authored seed cases remain available.</p></div><button className="text-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>;
  return <aside className="meta-capture-link" aria-label="Captured Meta investigation">
    <div className="capture-mark"><Icon name="code" size={24}/></div><div><span className="proof-kicker">REAL MUSE PROPOSALS · ONE KNOWN SEED</span><h3>A model plan you can follow all the way to proof.</h3><p>Muse Spark Open proposed the actions. Inspect the executed trace and all six captured validation results.</p><small>Captured live investigation · playback makes no new model calls.</small></div><a className="button secondary" href={`#job/${capturedMetaJob}`}>Inspect the Meta case <Icon name="arrow" size={15}/></a>
  </aside>;
}

type PlanView = 'proposal' | 'execution' | 'minimal';
const milliseconds = (value: number) => `${(value / 1000).toFixed(3)}s`;

export function InvestigationProof({ data, jobId }: { data: JobEvidence; jobId: string }) {
  const [view, setView] = useState<PlanView>(data.proposal ? 'proposal' : 'execution');
  const [runIndex, setRunIndex] = useState(0);
  const [imageError, setImageError] = useState(false);
  const id = useId();
  const views: { id: PlanView; title: string }[] = [...(data.proposal ? [{ id: 'proposal' as const, title: 'Model proposal' }] : []),
    { id: 'execution', title: 'Browser execution' }, { id: 'minimal', title: 'Minimized replay' }];
  const actions = view === 'minimal' ? data.actions : view === 'proposal' ? data.proposal!.proposedActions : data.initialActions;
  const removed = removedSteps(data.initialActions, data.actions);
  const selected = data.validationRuns[runIndex];
  const artifactBase = `/api/job-artifacts/${jobId}`;
  const runBase = `${artifactBase}/${selected.artifactDirectory}`;
  const chooseRun = (index: number) => { setImageError(false); setRunIndex(index); };
  return <section className="investigation-proof" aria-label="Investigation decision record">
    <div className="decision-heading"><div><span className="proof-kicker">{data.proposal ? 'CAPTURED MODEL DECISION' : 'CAPTURED AUTHORED PLAN'}</span><h3>{data.proposal ? 'Model proposed. Browser judged.' : 'Authored plan. Browser judged.'}</h3><p>{data.proposal ? 'Follow the accepted proposal into the worker trace, then see what the verifier kept.' : 'This recorded job used an authored plan. Its executed browser results are shown below.'}</p></div><span className="decision-mode">{data.modelCalls} MODEL {data.modelCalls === 1 ? 'CALL' : 'CALLS'}</span></div>
    <div className="decision-tabs" role="tablist" aria-label="Investigation action sequences" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = views.findIndex(item => item.id === view);
      const next = views[event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length].id;
      setView(next); document.getElementById(`${id}-${next}`)?.focus();
    }}>{views.map(item => <button key={item.id} id={`${id}-${item.id}`} role="tab" aria-selected={view === item.id} tabIndex={view === item.id ? 0 : -1} aria-controls={`${id}-actions`} onClick={() => setView(item.id)}>{item.title}<span>{item.id === 'minimal' ? data.actions.length : data.initialActions.length}</span></button>)}</div>
    <div className="decision-plan" id={`${id}-actions`} role="tabpanel" aria-labelledby={`${id}-${view}`}>
      <ol className="decision-actions">{actions.map((action, index) => <li key={index} data-removed={view !== 'minimal' && removed.has(index)}><span className="decision-step">{String(index + 1).padStart(2, '0')}</span><div><b>{actionLabel(action)}</b><small>{view === 'execution' ? `Worker +${milliseconds(data.initialTrace[index].atMs)} · ${data.initialTrace[index].elapsedMs}ms action` : view === 'proposal' ? 'Accepted structured model action' : 'Retained by the deterministic minimizer'}</small></div>{view !== 'minimal' && removed.has(index) ? <span className="removed-action">REMOVED IN MINIMIZATION</span> : view === 'execution' ? <Icon name="check" size={15}/> : null}</li>)}</ol>
      <p className="decision-footnote">{view === 'execution' ? 'These are worker timestamps from the initial run, separate from the input recording timeline.' : view === 'minimal' ? 'Bounded deletion search. The assertion and schedule stayed locked; this is not a claim of a global minimum.' : 'The accepted proposal matches the initial executed actions. The model did not decide whether the assertion passed.'}</p>
    </div>
    {data.proposal && <details className="model-input-proof"><summary>Inspect recording samples and model configuration <Icon name="plus" size={15}/></summary><div className="model-input-content"><p>These sampled input recording frames guided the proposal. Executed browser assertions establish the outcome; sampling can miss fast interactions.</p><ol className="input-frame-records">{data.proposal.frames.map((frame, index) => <li key={frame.timestampMs}><span>FRAME {String(index + 1).padStart(2, '0')} · {milliseconds(frame.timestampMs)}</span><code>{frame.sha256}</code></li>)}</ol><dl className="model-configuration"><dt>Provider</dt><dd>{data.proposal.provider}</dd><dt>Configured model</dt><dd><code>{data.proposal.model}</code></dd><dt>Proposal ID</dt><dd><code>{data.proposal.proposalId}</code></dd><dt>Call started (UTC)</dt><dd>{new Date(data.proposal.attemptedAt * 1000).toISOString()}</dd><dt>This proposal’s usage</dt><dd>{data.proposal.inputTokens.toLocaleString()} input + {data.proposal.outputTokens.toLocaleString()} output tokens</dd><dt>Estimated inference</dt><dd>{data.proposal.estimatedCostUsd === null ? 'Unavailable' : `$${data.proposal.estimatedCostUsd.toFixed(6)}`} · not final billing</dd></dl><a className="text-link" href={`${artifactBase}/provenance.json`} download>Download model provenance <Icon name="download" size={15}/></a></div></details>}
    <div className="validation-heading"><div><span className="proof-kicker">SIX CAPTURED VALIDATION RUNS</span><h4>Inspect the result, run by run.</h4></div><span>Same actions · same schedule · same assertion</span></div>
    <div className="validation-run-picker" role="group" aria-label="Captured validation runs">{data.validationRuns.map((run, index) => <button key={`${run.variant}-${run.ordinal}`} aria-label={`Inspect ${run.variant} run ${run.ordinal}`} aria-pressed={runIndex === index} data-variant={run.variant} onClick={() => chooseRun(index)}><Icon name={run.passed ? 'check' : 'bug'} size={14}/><span>{run.variant} {String(run.ordinal).padStart(2, '0')}</span></button>)}</div>
    <div className="validation-inspector" aria-label="Selected validation result"><div className="validation-observation"><span className={`validation-verdict ${selected.passed ? 'is-pass' : 'is-failure'}`}>{selected.passed ? 'ASSERTION PASSED' : 'ASSERTION FAILED'}</span><h4>{selected.variant === 'buggy' ? 'The bug was observed.' : 'The fixed run kept the promise.'}</h4><dl><dt>Expected</dt><dd><code>{JSON.stringify(selected.expected)}</code></dd><dt>Observed</dt><dd><code>{JSON.stringify(selected.actual)}</code></dd><dt>Elapsed</dt><dd>{milliseconds(selected.elapsedMs)}</dd></dl><a className="text-link" href={`${runBase}/result.json`} download>This run’s result <Icon name="download" size={14}/></a><a className="text-link" href={`${runBase}/trace.zip`} download>This run’s trace <Icon name="download" size={14}/></a></div><figure className="validation-frame">{imageError ? <p role="status">The captured screenshot is unavailable. Inspect this run’s result or trace.</p> : <img key={runBase} src={`${runBase}/final.png`} alt={`${selected.variant} validation run ${selected.ordinal}, captured final browser state`} loading="lazy" onError={() => setImageError(true)}/>}<figcaption>Captured worker screenshot · {selected.variant} run {selected.ordinal}. This is output evidence, separate from the model’s input samples.</figcaption></figure></div>
    <p className="decision-footnote">{data.excludedErrors > 0 ? `${data.excludedErrors} error outcomes elsewhere in this investigation were excluded from successful reproductions. ` : ''}Three repeated outcomes under one schedule do not establish general reliability. This view reads captured evidence; it starts no model or sandbox work.</p>
  </section>;
}
