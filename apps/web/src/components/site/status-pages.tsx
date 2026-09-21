import Link from 'next/link';

import { Button, Eyebrow } from '@xenon/ui';

import { XenonMark } from '~/components/brand/wordmark';

/**
 * Shared shell for every terminal page: 404, 403, 401, 500.
 *
 * One composition so an error never looks like it escaped from a different
 * product. Each page supplies a code, a line and a way out - an error page
 * without a route forward is a dead end, and people leave from dead ends.
 */
export function StatusPage({
  code,
  title,
  description,
  children,
}: {
  code: string;
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-5 py-24 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(60% 50% at 50% 30%, #101a10 0%, transparent 70%), linear-gradient(180deg, var(--color-void), var(--color-black))',
        }}
      />
      <div className="x-grid-field absolute inset-0 opacity-40" aria-hidden />

      <div className="relative flex max-w-lg flex-col items-center gap-6">
        <XenonMark className="size-9" />
        <Eyebrow accent>Error {code}</Eyebrow>
        <h1 className="font-display text-headline font-black text-ink uppercase">{title}</h1>
        <p className="leading-relaxed text-ink-secondary">{description}</p>

        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          {children ?? (
            <Button variant="accent" asChild>
              <Link href="/">Back to the city</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
