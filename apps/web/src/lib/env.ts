/**
 * Build-time environment facts for components.
 *
 * `process.env.NODE_ENV` is inlined by the compiler on both sides of the
 * client boundary, which makes it the one environment value a component may
 * read. Reading it through this module keeps that exception in a single file
 * rather than scattering `process.env` across the component tree, and matches
 * the repository's rule that configuration comes from a named module.
 */

/** True in `next dev`. Used to surface authoring aids that production hides. */
export const isDevelopment = process.env.NODE_ENV !== 'production';
