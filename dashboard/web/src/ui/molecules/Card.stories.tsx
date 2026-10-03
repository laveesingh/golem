import { useState } from 'react';
import { Button } from '../atoms/Button.tsx';
import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { Card } from './Card.tsx';
export function States() {
  const [count] = useState(0);
  return (
    <StoryFrame title="Card states">
      <Card
        title="Work summary"
        description="A shell-neutral group of related information"
        actions={<Button label="Review details" variant="quiet" />}
      >
        <p>Three tasks need review.</p>
      </Card>
      <Card
        title={'Unbroken'.repeat(18)}
        description={'Description'.repeat(30)}
      >
        <p>Long content reflows at narrow widths.</p>
      </Card>
      <output aria-label="Activations">{count}</output>
    </StoryFrame>
  );
}
