import { useState } from 'react';
import { StoryFrame } from '../workshop/StoryFrame.tsx';
import { Input } from './Input.tsx';
export function Default() {
  return (
    <StoryFrame title="Input">
      <Input
        id="input-empty"
        label="Item title"
        placeholder="Enter an item title"
      />
    </StoryFrame>
  );
}
export function Populated() {
  return (
    <StoryFrame title="Input populated">
      <Input id="input-filled" label="Item title" defaultValue="Example item" />
    </StoryFrame>
  );
}
export function Invalid() {
  return (
    <StoryFrame title="Input invalid">
      <Input
        id="input-invalid"
        label="Item title"
        error="Enter an item title."
        required
      />
    </StoryFrame>
  );
}
export function Disabled() {
  return (
    <StoryFrame title="Input disabled">
      <Input
        id="input-disabled"
        label="Item title"
        defaultValue="Unavailable"
        disabled
      />
    </StoryFrame>
  );
}
export function ReadOnly() {
  return (
    <StoryFrame title="Input read-only">
      <Input
        id="input-readonly"
        label="Item title"
        defaultValue="Read-only content"
        readOnly
      />
    </StoryFrame>
  );
}
export function Controlled() {
  const [value, setValue] = useState('');
  return (
    <StoryFrame title="Input controlled">
      <Input
        id="input-controlled"
        label="Controlled item title"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <p>Current value: {value}</p>
    </StoryFrame>
  );
}
export function Focus() {
  return (
    <StoryFrame title="Input focus">
      <p>Tab to the input for keyboard focus outline.</p>
      <Input id="focus-input" label="Focused item title" />
    </StoryFrame>
  );
}
export function UnbrokenText() {
  return (
    <StoryFrame title="Input unbroken text">
      <Input
        id="unbroken-only"
        label={'Label_'.repeat(20)}
        error={'Error_'.repeat(20)}
      />
    </StoryFrame>
  );
}
export function States() {
  const [value, setValue] = useState('Example');
  return (
    <StoryFrame title="Input states">
      <Input
        id="empty"
        label="Empty item title"
        placeholder="Placeholder is not the label"
      />
      <Input
        id="controlled"
        label="Controlled item title"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Input
        id="uncontrolled"
        label="Uncontrolled item title"
        defaultValue="Uncontrolled example"
      />
      <Input
        id="invalid"
        label="Invalid item title"
        error="Enter an item title before continuing."
        required
      />
      <Input
        id="disabled"
        label="Disabled item title"
        defaultValue="Disabled example"
        disabled
      />
      <Input
        id="readonly"
        label="Read-only item title"
        defaultValue="Read-only example"
        readOnly
      />
      <Input
        id="long"
        label="An extremely long descriptive field label that wraps in the narrow container"
        defaultValue="A long populated value does not replace the accessible field label"
      />
      <Input
        id="unbroken"
        label={'Label_'.repeat(20)}
        error={'Error_'.repeat(20)}
        defaultValue={'Native_value_'.repeat(20)}
      />
    </StoryFrame>
  );
}
