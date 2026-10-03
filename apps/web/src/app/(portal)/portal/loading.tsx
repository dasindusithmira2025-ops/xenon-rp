import { PortalSkeleton } from '~/components/motion/skeletons';

/** Portal loading state. Panels at the heights the real ones use. */
export default function Loading(): React.ReactElement {
  return <PortalSkeleton />;
}
