/**
 * Marketing copy.
 *
 * EDITABLE CONTENT, NOT PRODUCTION FACT.
 *
 * Everything in this file is written about roleplay as a form rather than about
 * mechanics XenonRP has confirmed. Nothing here claims a feature exists, quotes
 * a statistic, names a staff member or invents community history - those come
 * from the database, from /control, or not at all.
 *
 * Owners are expected to rewrite this in their own voice. It lives in one
 * module, separate from every component, so that rewriting it never means
 * touching layout code.
 */

export interface StoryPath {
  readonly key: string;
  readonly label: string;
  readonly headline: string;
  readonly body: string;
  readonly note: string;
}

/**
 * The five ways into the city.
 *
 * The criminal path is written as ambition and consequence rather than as
 * violence, because "join a gang and shoot people" describes a deathmatch
 * server and this is not one.
 */
export const storyPaths: readonly StoryPath[] = [
  {
    key: 'civilian',
    label: 'Civilian',
    headline: 'An ordinary life is still a life worth playing.',
    body: 'Rent a place. Take a job. Learn which streets are worth walking at night. The city does not hand you a story - it hands you a morning, and what you do with it becomes one.',
    note: 'Where most stories start',
  },
  {
    key: 'police',
    label: 'Police',
    headline: 'The badge is a promise you have to keep.',
    body: 'Patrol, respond, investigate, testify. Every stop is a decision someone remembers, and every shortcut you take is one a defence lawyer will find. Authority here is earned in public and lost the same way.',
    note: 'Whitelisted department',
  },
  {
    key: 'ems',
    label: 'EMS',
    headline: 'Somebody has to be calm.',
    body: 'You arrive after the worst has already happened. Triage, treat, transport, and hold a scene together while everyone else is shouting. The most respected people in any city are the ones who show up.',
    note: 'Whitelisted department',
  },
  {
    key: 'entrepreneur',
    label: 'Entrepreneur',
    headline: 'Build something the city needs.',
    body: 'A garage, a bar, a delivery outfit, a studio. Hire people. Keep them paid. Find out what it costs to be the person everyone relies on, and whether the city protects what you build or simply notices it.',
    note: 'Player-driven business',
  },
  {
    key: 'underworld',
    label: 'Underworld',
    headline: 'Own the night.',
    body: 'Build alliances. Control markets. Create enemies. Reputation in the underworld is the only currency that matters, and it is spent the moment it is used. Everything you take leaves a name attached to it.',
    note: 'Consequence-first criminal roleplay',
  },
];

export interface CitySystem {
  readonly title: string;
  readonly body: string;
}

/**
 * What the city is built around.
 *
 * Deliberately about the shape of play rather than about implementation. An
 * owner adding "twelve legal jobs and a fully simulated stock market" should do
 * so here, once they are true.
 */
export const citySystems: readonly CitySystem[] = [
  {
    title: 'Consequence',
    body: 'Actions follow you. What you did last month is still true this month, and the people who were there still remember it.',
  },
  {
    title: 'Reputation',
    body: 'Nobody is told who you are. They find out, from the people you have already dealt with.',
  },
  {
    title: 'Economy',
    body: 'Money moves between players far more than it appears from nowhere. Someone has to be selling what you are buying.',
  },
  {
    title: 'Organisations',
    body: 'Crews, businesses, departments and syndicates are run by players, with the friction and politics that implies.',
  },
  {
    title: 'Investigation',
    body: 'Crime that leaves nothing behind is not roleplay. Evidence, witnesses and paperwork are part of the story on both sides.',
  },
  {
    title: 'Character',
    body: 'One life at a time, played properly. Your character is a person before they are a role.',
  },
];

export interface CityFacet {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
}

/** Sections of the /city page. */
export const cityFacets: readonly CityFacet[] = [
  {
    eyebrow: 'Streets',
    title: 'A city that is somewhere, not anywhere',
    body: 'Neighbourhoods have character because the people in them keep showing up. The same faces at the same garage, the same argument outside the same bar, the same corner nobody parks on after dark.',
    points: [
      'Persistent characters rather than respawning avatars',
      'Locations that acquire meaning through use',
      'Events driven by players, not by a calendar',
    ],
  },
  {
    eyebrow: 'Work',
    title: 'Every job is somebody else’s story',
    body: 'The mechanic who fixes your car is a person having a day. The dispatcher on the radio is making choices. Livelihoods here are interactions, which is why they are worth playing at all.',
    points: [
      'Player-run businesses and services',
      'Employment that creates relationships, not just income',
      'Specialisation that makes you worth knowing',
    ],
  },
  {
    eyebrow: 'Law',
    title: 'Order is a negotiation',
    body: 'Policing and crime are two halves of one story, and neither works without the other taking it seriously. The interesting part is never the chase - it is what happens afterwards.',
    points: [
      'Investigation and evidence over instant resolution',
      'Courts and consequence rather than a reset',
      'Escalation that has to be earned',
    ],
  },
  {
    eyebrow: 'Nights',
    title: 'The city after dark belongs to whoever takes it',
    body: 'Markets, territory, alliances, grudges. The underworld is structured, social and political long before it is violent, and the people who last are the ones who understand that.',
    points: [
      'Organisations with identity and history',
      'Territory that is held socially as well as physically',
      'Rivalries with a beginning that someone can point to',
    ],
  },
];

/** Homepage community section. Facts about the community come from the database. */
export const communityCopy = {
  eyebrow: 'Community',
  title: 'The city is only as good as the people in it',
  body: 'Xenon is built around players who turn up for each other: departments that train their own, businesses that hire, crews that recruit, and a staff team that reads every application properly rather than skimming it.',
} as const;

export const creatorCopy = {
  eyebrow: 'Creators',
  title: 'Bring your audience into the story',
  body: 'Streamers and creators are part of how a city gets known. If you make content here, we want the city to be worth filming - and we would rather support that properly than notice it after the fact.',
  cta: 'Talk to us about creator access',
} as const;

export const whitelistCopy = {
  eyebrow: 'Whitelist',
  title: 'Write your way in',
  body: 'Xenon is whitelisted because the standard is the point. The application asks you to think about who your character is and how you intend to play them. It is read by a person, and you get a real answer.',
} as const;
