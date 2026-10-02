import type { ReactNode } from 'react';
import { useEffect } from 'react';
import '../tokens/entry.css';
import './workshop.css';

export function StoryFrame({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    document.documentElement.dataset.theme =
      params.get('atomTheme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.density =
      params.get('atomDensity') === 'compact' ? 'compact' : 'cozy';
    document.documentElement.lang = 'en';
  }, []);
  return (
    <main className="g-workshop" data-atom-panel={title}>
      <h1>{title}</h1>
      <div className="g-story-grid">{children}</div>
      <section className="g-font-samples" aria-label="Local Latin font samples">
        <span data-font-sample="body" className="g-font-body">
          Aa0123
        </span>
        <span data-font-sample="label" className="g-font-label">
          Aa0123
        </span>
        <span data-font-sample="strong" className="g-font-strong">
          Aa0123
        </span>
        <span data-font-sample="heading" className="g-font-heading">
          Aa0123
        </span>
        <span data-font-sample="code" className="g-font-code">
          Aa0123
        </span>
        <span data-font-sample="codeLabel" className="g-font-code-label">
          Aa0123
        </span>
        <span data-font-sample="codeStrong" className="g-font-code-strong">
          Aa0123
        </span>
      </section>
    </main>
  );
}
