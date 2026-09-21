/**
 * Brand constants shared by the website, the bot's embeds and generated
 * metadata. Single source so an embed colour can never drift from the CSS token.
 */
export const brand = {
  name: 'XenonRP',
  wordmark: 'XENON ROLEPLAY',
  shortName: 'XENON',
  /** Primary accent. Kept as both hex and integer for Discord embed colours. */
  green: '#2AFD23',
  greenInt: 0x2afd23,
  palette: {
    void: '#020302',
    black: '#050705',
    surface: '#090C09',
    surfaceElevated: '#0D110D',
    text: '#F5F7F5',
    textSecondary: '#A6ADA6',
    textMuted: '#686F68',
  },
  /** Semantic colours used for state in embeds and badges. */
  state: {
    successInt: 0x2afd23,
    infoInt: 0x4a9eff,
    warningInt: 0xffb020,
    dangerInt: 0xff4d4d,
    neutralInt: 0x686f68,
  },
} as const;

export const siteMeta = {
  title: 'XenonRP | Sri Lankan FiveM Roleplay',
  tagline: 'THIS CITY REMEMBERS.',
  description:
    'XenonRP is a Sri Lankan FiveM roleplay city. Your actions create your reputation. Your story defines the city.',
  locale: 'en_US',
} as const;
