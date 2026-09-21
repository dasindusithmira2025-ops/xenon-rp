import { XenonMark } from '~/components/brand/wordmark';

/**
 * Route-level loading state.
 *
 * Just the mark, held still. A full skeleton here would be guessing at the
 * shape of whatever page is arriving; each route that benefits from a real
 * skeleton supplies its own.
 */
export default function Loading(): React.ReactElement {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <XenonMark className="size-8 animate-pulse motion-reduce:animate-none" title="Loading" />
    </div>
  );
}
