import type { PlatformStatusViewModel } from './platform-status-view-model';

export interface PlatformStatusCardProps {
  readonly status: PlatformStatusViewModel;
}

export function PlatformStatusCard({ status }: PlatformStatusCardProps) {
  return (
    <section className={`status-card status-card--${status.state}`} aria-labelledby="status-title">
      <p className="status-card__eyebrow">Platform availability</p>
      <h2 id="status-title">{status.label}</h2>
      <p>{status.explanation}</p>
      {'observation' in status ? (
        <dl className="status-card__source">
          <div>
            <dt>Observed</dt>
            <dd>
              <time dateTime={status.observation.asOf}>{status.observation.asOf}</time>
            </dd>
          </div>
          <div>
            <dt>API version</dt>
            <dd>{status.observation.serviceVersion}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
