import './molecules.css';
export type ListRowProps = {
  title: string;
  description?: string;
  meta?: string;
  selected?: boolean;
  disabled?: boolean;
  onActivate?: () => void;
};
export function ListRow({
  title,
  description,
  meta,
  selected,
  disabled,
  onActivate,
}: ListRowProps) {
  const content = (
    <>
      <span className="g-row-content">
        <span className="g-row-title">{title}</span>
        {description && (
          <span className="g-row-description">{description}</span>
        )}
      </span>
      {meta && <span className="g-row-meta">{meta}</span>}
    </>
  );
  return onActivate ? (
    <button
      type="button"
      className="g-list-row"
      data-selected={selected || undefined}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onActivate}
    >
      {content}
    </button>
  ) : (
    <div className="g-list-row" data-selected={selected || undefined}>
      {content}
    </div>
  );
}
