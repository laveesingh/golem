import { useState } from 'react';
import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { ListRow } from './ListRow.tsx';
export function States() {
  const [count, setCount] = useState(0);
  return (
    <StoryFrame title="ListRow states">
      <ListRow
        title="Read the requirements"
        description="Noninteractive information row"
        meta="Review"
      />
      <ListRow
        title="Open task"
        description="Native button activation"
        onActivate={() => setCount((value) => value + 1)}
        meta="Ready"
      />
      <ListRow
        title="Selected task"
        selected
        onActivate={() => setCount((value) => value + 1)}
        meta="Selected"
      />
      <ListRow
        title="Unavailable task"
        disabled
        onActivate={() => setCount((value) => value + 1)}
      />
      <ListRow
        title={'Unbroken'.repeat(20)}
        description={'Description'.repeat(25)}
        meta="Long"
      />
      <output aria-label="Activations">{count}</output>
    </StoryFrame>
  );
}
