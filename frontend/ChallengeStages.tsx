const stages = [
  { id: 'play', title: 'Play', detail: 'Find the break' },
  { id: 'reveal', title: 'Reveal', detail: 'Follow the sequence' },
  { id: 'evidence', title: 'Evidence', detail: 'Inspect the proof' },
] as const;

export function ChallengeStages({ active }: { active: 'play' | 'reveal' | 'evidence' }) {
  const activeIndex = stages.findIndex(stage => stage.id === active);
  return <ol className="challenge-stages" aria-label="Challenge stages">
    {stages.map((stage, index) => <li key={stage.id} aria-current={active === stage.id ? 'step' : undefined}
      data-position={index < activeIndex ? 'previous' : index === activeIndex ? 'current' : 'upcoming'}>
      <span className="stage-number" aria-hidden="true">0{index + 1}</span>
      <span><b>{stage.title}</b><small>{stage.detail}</small></span>
    </li>)}
  </ol>;
}
