import type { OnboardingStep, UserStatus, WhitelistState } from '@xenon/database';

/**
 * Session shape.
 *
 * Declaration merging rather than a wrapper type, so `auth()` returns the
 * enriched session everywhere without every call site remembering to cast.
 *
 * Note what is deliberately absent: capabilities and role keys. Putting them on
 * the session would make authorization a snapshot taken at sign-in, and a
 * revoked permission would keep working for up to thirty days.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      publicId: string | null;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      status: UserStatus;
      whitelistState: WhitelistState;
      onboardingStep: OnboardingStep;
    };
    expires: string;
  }
}

export {};
