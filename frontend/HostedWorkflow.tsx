import { assetUrl } from './public-demo';
import { Icon } from './icons';

export function HostedWorkflow({ onBack }: { onBack: () => void }) {
  return <section className="create-heading" aria-labelledby="hosted-creator-title">
    <div className="eyebrow">BRING YOUR OWN BUG</div>
    <h1 id="hosted-creator-title">Run the creator locally.</h1>
    <p>The online arcade lets you play the five included cases and explore their captured evidence. To investigate your own app, run the creator on your machine with your model access and sandbox budget.</p>
    <div className="hero-actions">
      <a className="button primary" href="https://github.com/himanshu748/bugarcade/blob/main/docs/GETTING_STARTED.md">Set up the creator <Icon name="external" size={16}/></a>
      <button className="button secondary" onClick={onBack}>Back to the arcade <Icon name="play" size={16}/></button>
    </div>
    <p><a className="text-link" href={assetUrl('proof/view.html')}>Follow a captured Meta investigation <Icon name="arrow" size={16}/></a></p>
  </section>;
}
