import type { ReactNode } from 'react';
import './molecules.css';
export function EmptyState({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section className="g-empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {actions && <div className="g-empty-actions">{actions}</div>}
    </section>
  );
}
