import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { Pill } from './Pill.tsx';
export function Default() {
  return (
    <StoryFrame title="Pill">
      <Pill />
    </StoryFrame>
  );
}
export function LongLabel() {
  return (
    <StoryFrame title="Pill long label">
      <Pill
        status="working"
        label="Working on an extremely long label that wraps without duplicate live announcements"
      />
    </StoryFrame>
  );
}
export function Working() {
  return (
    <StoryFrame title="Pill working">
      <Pill status="working" />
    </StoryFrame>
  );
}
export function Idle() {
  return (
    <StoryFrame title="Pill idle">
      <Pill status="idle" />
    </StoryFrame>
  );
}
export function Review() {
  return (
    <StoryFrame title="Pill review">
      <Pill status="review" />
    </StoryFrame>
  );
}
export function Blocked() {
  return (
    <StoryFrame title="Pill blocked">
      <Pill status="blocked" />
    </StoryFrame>
  );
}
export function Done() {
  return (
    <StoryFrame title="Pill done">
      <Pill status="done" />
    </StoryFrame>
  );
}
export function Triage() {
  return (
    <StoryFrame title="Pill triage">
      <Pill status="triage" />
    </StoryFrame>
  );
}
export function Open() {
  return (
    <StoryFrame title="Pill open">
      <Pill status="open" />
    </StoryFrame>
  );
}
export function States() {
  return (
    <StoryFrame title="Pill states">
      <Pill />
      <Pill status="working" />
      <Pill status="idle" />
      <Pill status="review" />
      <Pill status="blocked" />
      <Pill status="done" />
      <Pill status="triage" />
      <Pill status="open" />
      <Pill
        status="working"
        label="Working on an extremely long descriptive label"
      />
    </StoryFrame>
  );
}
