import type { ReactNode } from 'react';
import { useId } from 'react';
import './molecules.css';
export type CardHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  id?: string;
  level?: 2 | 3 | 4;
};
export function CardHeader({
  title,
  description,
  actions,
  id,
  level = 2,
}: CardHeaderProps) {
  const Heading = level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
  return (
    <header className="g-card-header">
      <div>
        <Heading id={id}>{title}</Heading>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="g-card-actions">{actions}</div>}
    </header>
  );
}
export function Card({
  title,
  description,
  actions,
  children,
  level = 2,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  level?: 2 | 3 | 4;
}) {
  const id = useId();
  return (
    <article className="g-card" aria-labelledby={id}>
      <CardHeader
        title={title}
        description={description}
        actions={actions}
        id={id}
        level={level}
      />
      <div className="g-card-body">{children}</div>
    </article>
  );
}
