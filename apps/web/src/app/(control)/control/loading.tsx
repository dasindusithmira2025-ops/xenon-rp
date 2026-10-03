import { ControlSkeleton } from '~/components/motion/skeletons';

/**
 * Control centre loading state.
 *
 * A structural placeholder rather than a spinner, because every screen behind
 * this boundary is the same shape - heading, filters, table - and staff move
 * between them constantly. Holding the layout means the page does not jump when
 * the rows land, and the eye is already in the right place.
 */
export default function Loading(): React.ReactElement {
  return <ControlSkeleton />;
}
