'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';

import { Button, useToast } from '@xenon/ui';

/**
 * Copy the connect string.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be
 * refused by permissions policy, so the failure path is a toast telling the
 * player to copy it by hand rather than a button that silently does nothing.
 */
export function CopyConnect({ value }: { value: string }): React.ReactElement {
  const toast = useToast();
  const [copied, setCopied] = React.useState(false);

  return (
    <Button
      variant="outline"
      className="shrink-0"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 2000);
          })
          .catch(() => {
            toast.error('Could not copy', 'Select the connect string above and copy it manually.');
          });
      }}
    >
      {copied ? (
        <>
          <Check /> Copied
        </>
      ) : (
        <>
          <Copy /> Copy connect
        </>
      )}
    </Button>
  );
}
