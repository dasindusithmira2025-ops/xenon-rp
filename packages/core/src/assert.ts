import { ConflictError } from './errors';

/**
 * Compile-time exhaustiveness guard for discriminated unions.
 *
 * Placing this in a switch's `default` turns "someone added a status and forgot
 * a branch" into a type error rather than a silent fallthrough at runtime.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new ConflictError(
    `Unhandled ${context}: ${JSON.stringify(value)}`,
    'That action is not available right now.',
  );
}

/** Narrow away null/undefined where the caller knows better than the types. */
export function assertPresent<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new ConflictError(message);
  }
}
