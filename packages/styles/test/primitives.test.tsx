import { cleanup, render, screen } from '@testing-library/react';
import { useId } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../src/primitives/button.js';
import { Card } from '../src/primitives/card.js';
import { FieldError } from '../src/primitives/field-error.js';
import { Input } from '../src/primitives/input.js';
import { Label } from '../src/primitives/label.js';
import { Spinner } from '../src/primitives/spinner.js';

afterEach(cleanup);

/** DoD item 2 — "primitives render (vitest + testing-library smoke)". */
describe('primitive render smoke', () => {
  it('renders Button as a <button> that defaults to type="button"', () => {
    render(<Button>Submit</Button>);
    const button = screen.getByRole('button', { name: 'Submit' });
    expect(button.tagName).toBe('BUTTON');
    // Not `submit`: a button inside a form that submits it by accident is the bug this default
    // exists to prevent.
    expect(button.getAttribute('type')).toBe('button');
  });

  it('lets a caller opt into type="submit"', () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('type')).toBe('submit');
  });

  it('renders Input and forwards native input props', () => {
    render(<Input placeholder="Anything" defaultValue="seeded" />);
    const input = screen.getByPlaceholderText('Anything');
    expect(input.tagName).toBe('INPUT');
    expect((input as HTMLInputElement).value).toBe('seeded');
  });

  it('renders Label bound to its control through htmlFor', () => {
    // `useId` rather than a literal id — the same discipline features must use, and what biome's
    // useUniqueElementIds enforces.
    function LabelledField() {
      const fieldId = useId();
      return (
        <>
          <Label htmlFor={fieldId}>Email</Label>
          <Input id={fieldId} />
        </>
      );
    }
    render(<LabelledField />);
    // getByLabelText resolves the label/control pairing the same way assistive tech does.
    expect(screen.getByLabelText('Email').tagName).toBe('INPUT');
  });

  it('renders FieldError with role="alert" so a failed submit is announced', () => {
    render(<FieldError>Required</FieldError>);
    expect(screen.getByRole('alert').textContent).toBe('Required');
  });

  it("lets a caller override FieldError's role for non-reactive hint copy", () => {
    render(<FieldError role="note">Hint</FieldError>);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders Card as a plain surface container around its children', () => {
    render(<Card data-testid="card">contents</Card>);
    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('DIV');
    expect(card.textContent).toBe('contents');
  });

  it('renders Spinner with role="status" and an accessible name', () => {
    render(<Spinner label="Loading items" />);
    expect(screen.getByRole('status').textContent).toBe('Loading items');
  });

  it('lets a caller className override a primitive default for the same utility group', () => {
    // The `cn` contract, proven through a real render rather than only through the helper.
    render(<Card className="rounded-pill" data-testid="card" />);
    const className = screen.getByTestId('card').className;
    expect(className).toContain('rounded-pill');
    expect(className).not.toContain('rounded-surface');
  });
});
