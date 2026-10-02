import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { IconButton } from './IconButton.tsx';

const glyph = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export function Default() {
  return (
    <StoryFrame title="IconButton">
      <IconButton label="Add item" icon={glyph} />
    </StoryFrame>
  );
}
export function Primary() {
  return (
    <StoryFrame title="IconButton primary">
      <IconButton label="Add item" icon={glyph} variant="primary" />
    </StoryFrame>
  );
}
export function Busy() {
  return (
    <StoryFrame title="IconButton busy">
      <IconButton label="Add item" icon={glyph} busy />
    </StoryFrame>
  );
}
export function Disabled() {
  return (
    <StoryFrame title="IconButton disabled">
      <IconButton label="Add item" icon={glyph} disabled />
    </StoryFrame>
  );
}

export function Hover() {
  return (
    <StoryFrame title="IconButton hover">
      <p>Hover preserves named native action.</p>
      <IconButton label="Add item" icon={glyph} />
    </StoryFrame>
  );
}
export function Active() {
  return (
    <StoryFrame title="IconButton active">
      <p>Press pointer or Space for active paint.</p>
      <IconButton label="Add item" icon={glyph} />
    </StoryFrame>
  );
}
export function Focus() {
  return (
    <StoryFrame title="IconButton focus">
      <p>Tab reaches the hit target without clipping the perimeter.</p>
      <IconButton label="Add item" icon={glyph} />
    </StoryFrame>
  );
}
export function BusyFocus() {
  return (
    <StoryFrame title="IconButton busy focus">
      <IconButton label="Add item" icon={glyph} busy />
    </StoryFrame>
  );
}
export function DisabledBusy() {
  return (
    <StoryFrame title="IconButton disabled wins">
      <IconButton label="Add item" icon={glyph} busy disabled />
    </StoryFrame>
  );
}
export function States() {
  return (
    <StoryFrame title="IconButton states">
      <section className="g-story-row">
        <h2>Default / hover / active / focus</h2>
        <IconButton label="Add item" id="icon-default" icon={glyph} />
        <IconButton label="Primary add item" icon={glyph} variant="primary" />
      </section>
      <section className="g-story-row">
        <h2>Busy and focus / disabled</h2>
        <IconButton label="Busy add item" id="icon-busy" icon={glyph} busy />
        <IconButton label="Disabled add item" icon={glyph} disabled />
        <IconButton label="Disabled busy add item" icon={glyph} busy disabled />
      </section>
    </StoryFrame>
  );
}
