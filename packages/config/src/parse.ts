import type { z } from 'zod';

/**
 * Thrown when a process boots with configuration that is missing or malformed.
 * Carries the per-variable detail so operators see exactly what to fix rather
 * than a stack trace from wherever the value was first dereferenced.
 */
export class EnvironmentValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(scope: string, issues: readonly string[]) {
    super(
      [
        `Invalid ${scope} environment configuration:`,
        ...issues.map((issue) => `  - ${issue}`),
        '',
        'See .env.example for the full list of expected variables.',
      ].join('\n'),
    );
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

/**
 * Validate a raw environment record against a schema.
 *
 * Fails loudly and completely: every problem is reported at once so a developer
 * fixes one round of errors instead of discovering them one restart at a time.
 */
export function parseEnv<TSchema extends z.ZodType>(
  scope: string,
  schema: TSchema,
  source: Record<string, string | undefined>,
): z.output<TSchema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvironmentValidationError(scope, issues);
  }

  return result.data;
}

/**
 * Defer validation until first access.
 *
 * Next.js evaluates modules during build in contexts where runtime secrets are
 * intentionally absent; eagerly validating there would fail builds that are
 * actually fine. Deferring means the failure lands on the first real use.
 */
export function lazyEnv<T extends object>(factory: () => T): T {
  let cached: T | undefined;

  const resolve = (): T => {
    cached ??= factory();
    return cached;
  };

  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(resolve(), property),
    has: (_target, property) => Reflect.has(resolve(), property),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(resolve(), property),
  });
}
