import { useState } from 'react';
import { Button } from '../atoms/Button.tsx';
import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { EmptyState } from './EmptyState.tsx';
export function States() {
  const [count, setCount] = useState(0);
  return (
    <StoryFrame title="EmptyState states">
      <EmptyState
        title="No tasks yet"
        description="Create a task to begin tracking this project."
        actions={
          <Button
            label="Create task"
            onClick={() => setCount((value) => value + 1)}
          />
        }
      />
      <EmptyState
        title="Nothing needs review"
        description="Reviewed tasks will appear here."
      />
      <EmptyState
        title={'Unbroken'.repeat(18)}
        description={'Description'.repeat(25)}
      />
      <output aria-label="Activations">{count}</output>
    </StoryFrame>
  );
}
