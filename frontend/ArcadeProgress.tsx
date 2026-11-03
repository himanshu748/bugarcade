import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import type { ReactNode } from 'react';
import type { Challenge } from './types';
import { Icon } from './icons';
import { caseStars, encodeProgress, mergeProgress, parseProgress, STORAGE_KEY, updateProgress } from './arcade-progress';
import type { CaseProgress, ProgressRecord } from './arcade-progress';

type ProgressEvent = { type: 'bug'; moves: number; target: number } | { type: 'fixed' };
type ProgressAction = { type: 'record'; key: string; event: ProgressEvent } | { type: 'merge'; cases: ProgressRecord };
const blank: CaseProgress = { bugFound: false, targetMet: false, fixedChecked: false, bestMoves: null };
const Context = createContext<{ cases: ProgressRecord; persistent: boolean; record: (key: string, event: ProgressEvent) => void } | null>(null);

function loadProgress() {
  try { return { cases: parseProgress(localStorage.getItem(STORAGE_KEY)), persistent: true }; }
  catch { return { cases: {} as ProgressRecord, persistent: false }; }
}

export function ArcadeProgressProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadProgress);
  const [cases, dispatch] = useReducer((state: ProgressRecord, action: ProgressAction) => action.type === 'record'
    ? updateProgress(state, action.key, action.event) : mergeProgress(state, action.cases), initial.cases);
  const [persistent, setPersistent] = useState(initial.persistent);
  const record = useCallback((key: string, event: ProgressEvent) => dispatch({ type: 'record', key, event }), []);
  useEffect(() => {
    const merge = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue !== null) dispatch({ type: 'merge', cases: parseProgress(event.newValue) });
    };
    window.addEventListener('storage', merge);
    return () => window.removeEventListener('storage', merge);
  }, []);
  useEffect(() => {
    try {
      // A second tab may have advanced after our initial render. Preserve that progress.
      const merged = mergeProgress(cases, parseProgress(localStorage.getItem(STORAGE_KEY)));
      if (merged !== cases) dispatch({ type: 'merge', cases: merged });
      localStorage.setItem(STORAGE_KEY, encodeProgress(merged));
      setPersistent(true);
    } catch { setPersistent(false); }
  }, [cases]);
  const value = useMemo(() => ({ cases, persistent, record }), [cases, persistent, record]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useArcadeProgress() {
  const value = useContext(Context);
  if (!value) throw new Error('Arcade progress requires its provider.');
  return value;
}

export function Stars({ count, className = '' }: { count: number; className?: string }) {
  return <span className={`arcade-stars ${className}`} role="img" aria-label={`${count} of 3 stars`}>
    {[0, 1, 2].map(index => <Icon key={index} name="star" size={16} className={index < count ? 'earned' : ''}/>)}
  </span>;
}

export function CaseBadge({ id }: { id: string }) {
  const { cases } = useArcadeProgress();
  const progress = cases[`seed:${id}`] || blank;
  const cleared = progress.bugFound && progress.fixedChecked;
  return <span className={`arcade-card-progress ${cleared ? 'is-cleared' : ''}`}>
    <span>{cleared ? 'CLEARED' : progress.bugFound ? 'BUG CAUGHT' : 'YOUR NEXT CHALLENGE'}</span>
    <Stars count={caseStars(progress)}/>
  </span>;
}

export function ArcadePassport({ challenges, onPlay }: { challenges: Challenge[]; onPlay: (id: string) => void }) {
  const { cases, persistent } = useArcadeProgress();
  const cleared = challenges.filter(item => cases[`seed:${item.id}`]?.fixedChecked && cases[`seed:${item.id}`]?.bugFound).length;
  const stars = challenges.reduce((total, item) => total + caseStars(cases[`seed:${item.id}`] || blank), 0);
  const next = challenges.find(item => !cases[`seed:${item.id}`]?.fixedChecked)
    || challenges.find(item => caseStars(cases[`seed:${item.id}`] || blank) < 3) || challenges[0];
  return <div className="arcade-passport" aria-label="Your arcade progress">
    <div className="passport-identity"><div><h3>{cleared === challenges.length ? 'The cabinet is cleared.' : cleared ? 'Your next mystery is waiting.' : 'Five cases. Your high score to write.'}</h3><p>{persistent ? 'Personal progress, saved in this browser.' : 'Storage unavailable. Progress lasts for this page only.'}</p></div></div>
    <div className="passport-score"><strong>{cleared}<small> / {challenges.length}</small></strong><span>Cases cleared</span><progress max={challenges.length} value={cleared} aria-label="Cases cleared"/></div>
    <div className="passport-score passport-star-score"><strong>{stars}<small> / {challenges.length * 3}</small></strong><span>Stars earned</span></div>
    <button className="button secondary" onClick={() => onPlay(next.id)}>{cleared === challenges.length ? 'Chase three stars' : cleared || stars ? 'Continue playing' : 'Start your run'}<Icon name="play" size={14}/></button>
  </div>;
}

export function CaseProgressRail({ progressKey, target }: { progressKey: string; target: number }) {
  const { cases, persistent } = useArcadeProgress();
  const progress = cases[progressKey] || blank;
  return <section className="arcade-case-rail" aria-label="Your case progress">
    <div className="arcade-case-score"><h3>Your stars</h3><Stars count={caseStars(progress)}/></div>
    <ol className="arcade-milestones">
      {[
        { earned: progress.bugFound, label: 'Catch the bug', detail: 'Your clicks. A real failure.', icon: 'bug' as const },
        { earned: progress.targetMet, label: `Aim for ${target} moves`, detail: 'Find a short way to break it.', icon: 'bolt' as const },
        { earned: progress.fixedChecked, label: 'Check the fix', detail: 'Replay after catching the bug.', icon: 'check' as const },
      ].map(item => <li key={item.label} data-earned={item.earned}><span className="milestone-icon"><Icon name={item.earned ? 'star' : item.icon} size={15}/></span><span><b>{item.label}</b><small>{item.earned ? 'STAR EARNED' : item.detail}</small></span></li>)}
    </ol>
    <div className="arcade-best"><span className="arcade-label">Personal best</span><strong>{progress.bestMoves === null ? 'Not yet' : `${progress.bestMoves} moves`}</strong></div>
    {!persistent && <p className="arcade-storage-note" role="status">Progress can’t be saved in this browser. Keep playing; it lasts for this page.</p>}
  </section>;
}

export function CaseReward({ progressKey, next, busy, onCheckFix, onRetry }: { progressKey: string; next: Challenge; busy: boolean; onCheckFix: () => void; onRetry: () => void }) {
  const { cases } = useArcadeProgress();
  const progress = cases[progressKey];
  if (!progress?.bugFound) return null;
  const cleared = progress.fixedChecked;
  return <section className={`arcade-reward ${cleared ? 'is-cleared' : ''}`} aria-label="Personal case result">
    <div className="reward-stamp" key={caseStars(progress)}><Icon name={cleared ? 'star' : 'bug'} size={29}/></div>
    <div className="reward-copy"><h2>{cleared ? progress.targetMet ? 'Three stars. One less mystery.' : 'You broke it. Then checked the fix.' : 'Nice catch. Now make the fix earn it.'}</h2><span className="arcade-label" role="status">{cleared ? 'CASE CLEARED' : 'BUG CAUGHT'}</span><p>{cleared ? `Best manual run: ${progress.bestMoves} moves.${progress.targetMet ? ' Move target met.' : ' The move-target star is still yours to chase.'}` : 'Replay the captured actions on the fixed build to clear this case.'}</p><span className="arcade-personal-note">Personal play progress · captured assertions remain the verification record.</span></div>
    <div className="reward-actions"><Stars count={caseStars(progress)}/>{cleared ? <><a className="button primary" href={`#play/${next.id}`}>Next case <Icon name="arrow" size={15}/></a><button className="text-button" onClick={onRetry}>Try for a better run <Icon name="reset" size={13}/></button></> : <button className="button primary" aria-label="Test the fix" disabled={busy} onClick={onCheckFix}>{busy ? 'Replaying…' : 'Test the fix'}<Icon name="play" size={15}/></button>}</div>
  </section>;
}
