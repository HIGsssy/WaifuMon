/**
 * A diagnostics card with a copy-to-clipboard affordance (plan §23).
 *
 * Every card on the page carries one so a developer can paste the whole block
 * into a bug report without re-typing it. The copy payload is supplied by the
 * card rather than scraped from the DOM, so it stays readable.
 */
import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export interface DiagnosticsCardProps {
  title: string;
  /** Plain-text form of the card, for the clipboard. */
  copyText?: string;
  children: ReactNode;
}

export function DiagnosticsCard({ title, copyText, children }: DiagnosticsCardProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      console.warn('[portal] clipboard unavailable');
    }
  }

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-ink-muted uppercase">{title}</h2>
        {copyText && (
          <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${title}`}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </div>
      {children}
    </Card>
  );
}

/** Key/value rows — the shape most diagnostics cards want. */
export function DiagnosticsRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="max-w-[60%] truncate text-right font-mono text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
