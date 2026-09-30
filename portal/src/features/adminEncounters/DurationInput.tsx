/**
 * A duration typed as "15 minutes" / "6 hours" / "1 day", stored as seconds.
 *
 * The unit the author picked is kept in local state, so typing `1` then
 * switching to `hours` means one hour rather than re-deriving the unit from
 * the seconds on every keystroke.
 */
import { useEffect, useId, useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { splitDuration, toSeconds, type DurationUnit } from './duration';
import { selectClass } from './EntitySelect';

interface Props {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
  disabled?: boolean | undefined;
}

export function DurationInput({ label, seconds, onChange, disabled }: Props) {
  const id = useId();
  const [unit, setUnit] = useState<DurationUnit>(() => splitDuration(seconds).unit);
  const [text, setText] = useState(() => String(splitDuration(seconds).value));

  // Follow an outside change (a loaded encounter, a template) without
  // fighting the author's own typing: only resync when the seconds differ
  // from what the current text already means.
  useEffect(() => {
    if (toSeconds(Number(text), unit) !== seconds) {
      const next = splitDuration(seconds);
      setUnit(next.unit);
      setText(String(next.value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);

  return (
    <div className="text-xs text-ink-muted">
      <label htmlFor={id}>{label}</label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="number"
          min="0"
          step="any"
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            onChange(toSeconds(Number(e.target.value), unit));
          }}
          className="w-24"
        />
        <select
          aria-label={`${label} unit`}
          value={unit}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value as DurationUnit;
            setUnit(next);
            onChange(toSeconds(Number(text), next));
          }}
          className={cn(selectClass, 'w-28')}
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
    </div>
  );
}
