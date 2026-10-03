import { useState } from 'react';
import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { Button } from './Button.tsx';
export function Default() {
  return (
    <StoryFrame title="Button">
      <Button label="Create item" />
    </StoryFrame>
  );
}
export function Quiet() {
  return (
    <StoryFrame title="Button quiet">
      <Button label="Cancel" variant="quiet" />
    </StoryFrame>
  );
}
export function Busy() {
  return (
    <StoryFrame title="Button busy">
      <Button label="Create item" busy />
    </StoryFrame>
  );
}
export function Disabled() {
  return (
    <StoryFrame title="Button disabled">
      <Button label="Create item" disabled />
    </StoryFrame>
  );
}
export function DisabledBusy() {
  return (
    <StoryFrame title="Button disabled wins">
      <Button label="Create item" busy disabled />
    </StoryFrame>
  );
}
export function LongLabel() {
  return (
    <StoryFrame title="Button long label">
      <Button label="Create an item with an extremely long accessible action label that must wrap without clipping focus" />
    </StoryFrame>
  );
}

export function Hover() {
  return (
    <StoryFrame title="Button hover">
      <p>
        Pointer hover: component.button.primary.hover background and foreground.
      </p>
      <Button label="Create item" />
    </StoryFrame>
  );
}
export function Active() {
  return (
    <StoryFrame title="Button active">
      <p>
        Press pointer or Space: component.button.primary.active background and
        foreground.
      </p>
      <Button label="Create item" />
    </StoryFrame>
  );
}
export function Focus() {
  return (
    <StoryFrame title="Button focus">
      <p>
        Tab focus: complete primary focus pair with an unclipped focus outline.
      </p>
      <Button label="Create item" />
    </StoryFrame>
  );
}
export function BusyFocus() {
  return (
    <StoryFrame title="Button busy focus">
      <p>Tab retains focus while busy pair suppresses duplicate activation.</p>
      <Button label="Create item" busy />
    </StoryFrame>
  );
}
export function States() {
  const [busy, setBusy] = useState(false),
    [count, setCount] = useState(0);
  return (
    <StoryFrame title="Button states">
      <section className="g-story-row">
        <h2>Primary default / hover / active / focus-visible</h2>
        <Button
          id="primary"
          label="Create item"
          onClick={() => setCount((n) => n + 1)}
        />
        <p aria-live="polite">Activations: {count}</p>
      </section>
      <section className="g-story-row">
        <h2>Quiet</h2>
        <Button label="Cancel" variant="quiet" />
      </section>
      <section className="g-story-row">
        <h2>Busy; tab to focus without activating</h2>
        <Button
          id="busy"
          label="Create item"
          busy
          onClick={() => setCount((n) => n + 1)}
        />
      </section>
      <section className="g-story-row">
        <h2>Native disabled / disabled wins over busy</h2>
        <Button id="disabled" label="Create item" disabled />
        <Button label="Create item" disabled busy />
      </section>
      <section className="g-story-row">
        <h2>Focus-preserving busy transition</h2>
        <Button
          id="transition"
          label="Run action"
          busy={busy}
          onClick={() => setBusy(true)}
        />
      </section>
      <section className="g-story-row">
        <h2>Long label</h2>
        <Button label="Create an item with an extremely long action label that wraps" />
      </section>
    </StoryFrame>
  );
}
