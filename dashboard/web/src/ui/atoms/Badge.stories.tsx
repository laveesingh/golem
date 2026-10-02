import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { Badge } from './Badge.tsx';
export function Zero() {
  return (
    <StoryFrame title="Badge zero">
      <Badge count={0} label="Items" />
    </StoryFrame>
  );
}
export function Count() {
  return (
    <StoryFrame title="Badge count">
      <Badge count={12} label="Items" />
    </StoryFrame>
  );
}
export function Overflow() {
  return (
    <StoryFrame title="Badge overflow">
      <Badge count={1234} label="Items" />
    </StoryFrame>
  );
}
export function Text() {
  return (
    <StoryFrame title="Badge text">
      <Badge text="Review required" />
    </StoryFrame>
  );
}
export function States() {
  return (
    <StoryFrame title="Badge states">
      <Badge count={0} label="Items" />
      <Badge count={7} label="Items" />
      <Badge count={99} label="Items" />
      <Badge count={1234} label="Items" />
      <Badge count={8} max={5} label="Items" />
      <Badge text="Review required" />
      <Badge text="An extremely long descriptive text-only badge label" />
    </StoryFrame>
  );
}
