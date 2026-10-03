'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';

export function CopyRuleLink({ slug }: { readonly slug: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        const url = `${window.location.origin}${window.location.pathname}#${slug}`;
        void navigator.clipboard
          .writeText(url)
          .then(() => {
            setCopied(true);
            setFailed(false);
            window.setTimeout(() => {
              setCopied(false);
            }, 1800);
          })
          .catch(() => {
            setFailed(true);
          });
      }}
      className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[0.625rem] tracking-[0.14em] text-ink-muted uppercase transition-colors hover:bg-elevated hover:text-ink"
      aria-label={failed ? 'Could not copy rule link' : 'Copy link'}
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      {copied ? 'Copied' : failed ? 'Try again' : 'Copy link'}
    </button>
  );
}
