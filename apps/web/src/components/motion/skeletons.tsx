import { Panel, Skeleton, SkeletonRows, SkeletonText, TableShell } from '@xenon/ui';
import { LoadingRail } from '@xenon/ui/motion';

/**
 * Route skeletons.
 *
 * One rule decides whether a screen gets one of these: does the shape of what
 * is arriving already exist? A control-centre queue is always a header, a
 * filter row and a table of the same width - so a placeholder can be exactly
 * right, and the real rows drop into a layout that has not moved. The public
 * site is the opposite: a hero, an editorial grid and a legal document share no
 * shape at all, so a skeleton there would be a guess that is wrong twice out of
 * three and shifts the page when it is.
 *
 * Where the shape is unknown, the honest answer is the navigation rail at the
 * top of the viewport and nothing else. A grey rectangle standing in for
 * something it does not resemble is worse than an empty frame, because the
 * reader tries to read it.
 *
 * None of these animate anything beyond the shared shimmer. They exist to hold
 * a shape, and a placeholder that draws attention to itself is competing with
 * the content it is waiting for.
 */

/** Page title and standfirst, at the size the real header will be. */
function HeaderSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-3.5 w-full max-w-lg" />
    </div>
  );
}

/**
 * The control centre.
 *
 * Every operational screen is a heading, a row of filters and a table, so this
 * is a genuine likeness rather than a generic block. The rail under the heading
 * is the same one used for a refresh, which keeps "first load" and "reloading"
 * in the same visual language.
 */
export function ControlSkeleton({ columns = 5 }: { columns?: number }): React.ReactElement {
  return (
    <div className="flex flex-col gap-6 p-5 lg:p-8">
      <HeaderSkeleton />
      <LoadingRail label="Loading" />

      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>

      <TableShell>
        <table className="w-full border-collapse text-sm">
          <tbody>
            <SkeletonRows rows={8} columns={columns} />
          </tbody>
        </table>
      </TableShell>
    </div>
  );
}

/**
 * The portal.
 *
 * A player's own pages are a stack of panels rather than a table, so this is a
 * column of cards at the heights the real ones use.
 */
export function PortalSkeleton(): React.ReactElement {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-8 lg:px-10 lg:py-12">
      <HeaderSkeleton />
      <LoadingRail label="Loading" />

      <Panel tone="raised" pad="lg" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-1 w-full" />
        <SkeletonText lines={2} />
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <Panel key={index} tone="flat" pad="lg" className="flex flex-col gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-3 w-full" />
          </Panel>
        ))}
      </div>
    </div>
  );
}
