import { LoadingRail } from '@xenon/ui/motion';

import { XenonMark } from '~/components/brand/wordmark';

/**
 * The root loading boundary.
 *
 * Deliberately almost nothing: the mark, a travelling rail, and the site's own
 * background. The portal and the control centre have their own boundaries with
 * real skeletons, because there the shape of what is arriving is known. This
 * one catches everything else - a hero, an article, a legal document, a gallery
 * - which share no shape at all, so a skeleton here would be a guess that
 * shifts the page when it lands.
 *
 * The rail is indeterminate because route loading genuinely is: there is no
 * percentage to report, and inventing one to look busier would be a lie in the
 * most-seen component in the product.
 */
export default function Loading(): React.ReactElement {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6">
      <XenonMark className="size-8" title="Loading" />
      <LoadingRail className="w-32" label="Loading" />
    </div>
  );
}
