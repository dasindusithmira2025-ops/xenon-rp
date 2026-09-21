/**
 * Domain error taxonomy.
 *
 * Services throw these instead of returning error shapes, and the transport
 * layers (server actions, route handlers, Discord interactions) translate them
 * once. That keeps the mapping from "what went wrong" to "what the user sees"
 * in a single place per transport rather than at every call site.
 *
 * `message` is developer-facing and may name internal ids. `safeMessage` is the
 * only text a transport may show to an end user.
 */
export abstract class DomainError extends Error {
  /** Stable machine-readable code, used by clients and by tests. */
  abstract readonly code: string;
  /** Closest HTTP status, used by route handlers. */
  abstract readonly httpStatus: number;
  /** Text safe to render to any user. Never contains internal identifiers. */
  abstract readonly safeMessage: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The requested entity does not exist, or the actor may not know that it does. */
export class NotFoundError extends DomainError {
  override readonly code = 'NOT_FOUND';
  override readonly httpStatus = 404;
  override readonly safeMessage = 'That no longer exists, or you do not have access to it.';

  constructor(
    public readonly entity: string,
    public readonly identifier?: string,
  ) {
    super(`${entity} not found${identifier === undefined ? '' : `: ${identifier}`}`);
  }
}

/** The actor is known but lacks the capability required. */
export class ForbiddenError extends DomainError {
  override readonly code = 'FORBIDDEN';
  override readonly httpStatus = 403;
  override readonly safeMessage = 'You do not have permission to do that.';

  constructor(
    public readonly required: string,
    public readonly actorId?: string | null,
  ) {
    super(`Missing required capability: ${required}`);
  }
}

/** No actor at all: the caller must sign in first. */
export class UnauthenticatedError extends DomainError {
  override readonly code = 'UNAUTHENTICATED';
  override readonly httpStatus = 401;
  override readonly safeMessage = 'Sign in to continue.';

  constructor(message = 'No authenticated actor') {
    super(message);
  }
}

/**
 * The operation is legal in principle but not against the current state, e.g.
 * approving a submission that is still a draft.
 */
export class ConflictError extends DomainError {
  override readonly code = 'CONFLICT';
  override readonly httpStatus = 409;

  constructor(
    message: string,
    override readonly safeMessage = 'That action is not available right now.',
  ) {
    super(message);
  }
}

/** Input failed validation. Carries per-field detail for form rendering. */
export class ValidationError extends DomainError {
  override readonly code = 'VALIDATION_FAILED';
  override readonly httpStatus = 422;
  override readonly safeMessage = 'Some answers need fixing before this can be saved.';

  constructor(
    public readonly fieldErrors: Readonly<Record<string, readonly string[]>>,
    message = 'Validation failed',
  ) {
    super(message);
  }
}

/** The actor exceeded a rate limit. */
export class RateLimitError extends DomainError {
  override readonly code = 'RATE_LIMITED';
  override readonly httpStatus = 429;

  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Rate limit exceeded',
  ) {
    super(message);
  }

  override get safeMessage(): string {
    const seconds = Math.max(1, Math.ceil(this.retryAfterSeconds));
    return seconds < 60
      ? `Too many attempts. Try again in ${seconds} seconds.`
      : `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minutes.`;
  }
}

/**
 * An external system (Discord, FXServer, object storage) failed.
 *
 * Distinct from the others because it is usually transient and retryable, and
 * because it must never roll back a domain decision that already committed.
 */
export class IntegrationError extends DomainError {
  override readonly code = 'INTEGRATION_FAILURE';
  override readonly httpStatus = 502;
  override readonly safeMessage =
    'An integration is temporarily unavailable. Your request was saved and will retry.';

  constructor(
    public readonly integration: string,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(`[${integration}] ${message}`, options);
    this.retryable = options?.retryable ?? true;
  }

  readonly retryable: boolean;
}

/** Narrowing helper for transports and job workers. */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Reduce any thrown value to something safe to show a user.
 *
 * Unknown errors deliberately collapse to a generic string: an unexpected
 * exception message can contain a connection string or a file path.
 */
export function toSafeMessage(error: unknown): string {
  return isDomainError(error) ? error.safeMessage : 'Something went wrong. Please try again.';
}
