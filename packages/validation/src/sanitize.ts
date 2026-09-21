import sanitizeHtml from 'sanitize-html';

/**
 * Allow-list for rich text written by staff (news bodies, department pages).
 *
 * Deliberately narrow: an editor needs structure and links, never scripts,
 * styles, iframes or event handlers. Everything outside the list is dropped
 * rather than escaped, so a stored payload cannot be revived by a later
 * rendering change.
 */
const richTextOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'blockquote',
    'ul',
    'ol',
    'li',
    'h2',
    'h3',
    'h4',
    'a',
    'code',
    'pre',
    'hr',
    'img',
    'figure',
    'figcaption',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    '*': ['id'],
  },
  // No `javascript:` or `data:` URLs: both are script-execution vectors in
  // href, and `data:` additionally defeats any CSP image-source restriction.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  transformTags: {
    // External links open in a new tab and must not hand the opener window to
    // the destination page.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
  },
  disallowedTagsMode: 'discard',
};

/** Sanitise staff-authored rich text before it is stored. */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, richTextOptions);
}

/**
 * Strip every tag. Used for player-authored free text (application answers,
 * ticket messages), which is rendered as plain text and never as markup.
 */
export function stripHtml(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
}

/** Rough reading length of rich text, for excerpts and list previews. */
export function plainTextPreview(html: string, maxLength = 180): string {
  const text = stripHtml(html).replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}\u2026`;
}
