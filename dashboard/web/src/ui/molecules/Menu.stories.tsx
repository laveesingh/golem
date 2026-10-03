import { useState } from 'react';
import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { Menu } from './Menu.tsx';
export function States() {
  const [count, setCount] = useState(0);
  return (
    <StoryFrame title="Menu states">
      <Menu
        label="Task actions"
        items={[
          {
            id: 'open',
            label: 'Open task',
            onSelect: () => setCount((value) => value + 1),
          },
          {
            id: 'disabled',
            label: 'Unavailable action',
            disabled: true,
            onSelect: () => setCount((value) => value + 100),
          },
          {
            id: 'review',
            label: 'Review task',
            onSelect: () => setCount((value) => value + 1),
          },
          {
            id: 'long',
            label: 'Long action label that wraps comfortably at narrow widths',
            onSelect: () => setCount((value) => value + 1),
          },
        ]}
      />
      <Menu label="Disabled menu" disabled items={[]} />
      <Menu
        label="No available actions"
        items={[
          {
            id: 'none',
            label: 'Unavailable',
            disabled: true,
            onSelect: () => setCount((value) => value + 100),
          },
        ]}
      />
      <output aria-label="Activations">{count}</output>
    </StoryFrame>
  );
}
