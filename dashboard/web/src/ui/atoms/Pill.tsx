import { requireText } from './action.ts';
import './atoms.css';
export type PillStatus =
  | 'neutral'
  | 'working'
  | 'idle'
  | 'review'
  | 'blocked'
  | 'done'
  | 'triage'
  | 'open';
export interface PillProps {
  status?: PillStatus;
  label?: string;
}
const labels: Record<PillStatus, string> = {
  neutral: 'Neutral',
  working: 'Working',
  idle: 'Idle',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  triage: 'Triage',
  open: 'Open',
};
export function Pill({
  status = 'neutral',
  label = labels[status],
}: PillProps) {
  requireText(label, 'Pill label');
  return (
    <span className="g-pill" data-status={status}>
      <span className="g-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
