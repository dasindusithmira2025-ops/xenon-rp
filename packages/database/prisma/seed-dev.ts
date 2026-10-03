import '@xenon/config/load-env';

import { isProduction } from '@xenon/config/datastore';

import { prisma } from '../src/client';
import { seedDevFixtureUsers } from '../src/dev-fixtures';

/**
 * Development fixtures.
 *
 * Never run automatically and never run in production - the first thing this
 * script does is refuse if NODE_ENV says production. It exists so a fresh clone
 * has enough content to look at every screen and to run the end-to-end suite
 * against something real.
 *
 * Everything here is invented for development. It is not XenonRP's actual
 * departments, rules, questions or staff, and it must be replaced before the
 * site is shown to anybody. The script sets `dev.fixturesLoaded`, which the
 * control centre renders as a standing banner, so nobody can forget that the
 * content on screen is fiction.
 *
 * Idempotent: every write is an upsert keyed on a natural key, so re-running it
 * updates rather than duplicates.
 */

if (isProduction()) {
  throw new Error('seed-dev must never run against production.');
}

// --- Settings ----------------------------------------------------------------

async function seedSettings(): Promise<void> {
  const values: [string, string, string, string][] = [
    [
      'community.discordInvite',
      'https://discord.gg/xenonrp-development-fixture',
      'community',
      'Discord invite URL',
    ],
    ['community.connectUrl', 'cfx.re/join/development', 'community', 'FiveM connect link'],
    ['applications.globallyOpen', 'true', 'applications', 'Applications open'],
    [
      'dev.fixturesLoaded',
      'true',
      'system',
      'Development fixture content is loaded in this database',
    ],
  ];

  for (const [key, value, category, label] of values) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, kind: 'STRING', category, label },
      update: { value },
    });
  }
}

// --- Game server -------------------------------------------------------------

async function seedServer(): Promise<void> {
  const server = await prisma.server.upsert({
    where: { slug: 'xenon-main' },
    create: {
      slug: 'xenon-main',
      name: 'Xenon City',
      // MOCK keeps the whole whitelist-sync path exercisable with no FXServer
      // anywhere. Swap to STANDALONE and set endpointUrl for a real server.
      adapter: 'MOCK',
      connectUrl: 'cfx.re/join/development',
      maxPlayers: 128,
      restartCron: '0 4,10,16,22 * * *',
      timezone: 'Asia/Colombo',
      isPublic: true,
    },
    update: {},
  });

  // One snapshot so the status page and the homepage strip have a live reading
  // to render rather than an "unknown" state on a fresh clone.
  await prisma.serverStatusSnapshot.create({
    data: {
      serverId: server.id,
      online: true,
      playerCount: 0,
      maxPlayers: 128,
      queueLength: 0,
      latencyMs: 12,
    },
  });
}

// --- Rules -------------------------------------------------------------------

interface RuleFixture {
  code: string;
  slug: string;
  title: string;
  description: string;
  examples?: string;
  severity: 'GUIDELINE' | 'STANDARD' | 'SERIOUS' | 'ZERO_TOLERANCE';
  aliases?: string[];
}

const ruleCategories: { slug: string; name: string; description: string; rules: RuleFixture[] }[] =
  [
    {
      slug: 'general',
      name: 'General conduct',
      description: 'The rules that apply everywhere, to everyone, all of the time.',
      rules: [
        {
          code: 'GEN-1',
          slug: 'respect',
          title: 'Treat people as people',
          description:
            'Harassment, slurs, and hate of any kind end a stay here. In character conflict is part of roleplay; out of character abuse is not, and the difference is never unclear to the person receiving it.',
          severity: 'ZERO_TOLERANCE',
          aliases: ['toxicity', 'harassment'],
        },
        {
          code: 'GEN-2',
          slug: 'stay-in-character',
          title: 'Stay in character',
          description:
            'Once you are connected you are your character. Out of character chatter belongs in Discord or in an admin ticket, not in the middle of a scene somebody else is trying to play.',
          examples:
            'Breaking to complain about a scene, discussing another player’s stream, or narrating game mechanics out loud.',
          severity: 'STANDARD',
          aliases: ['OOC', 'breaking character'],
        },
        {
          code: 'GEN-3',
          slug: 'fail-rp',
          title: 'Play the situation, not the game',
          description:
            'Your character should behave like a person who can be hurt, arrested and remembered. Acting without regard for consequence, fear or the fiction is FailRP.',
          examples:
            'Walking calmly into an active firefight, driving a hatchback off a bridge and continuing the conversation, ignoring a gun pointed at you.',
          severity: 'SERIOUS',
          aliases: ['FailRP', 'Fail RP'],
        },
        {
          code: 'GEN-4',
          slug: 'metagaming',
          title: 'No metagaming',
          description:
            'Information your character did not learn in character does not exist to them. Streams, Discord, and knowing the player behind a mask are all outside the city.',
          severity: 'SERIOUS',
          aliases: ['Metagaming', 'meta', 'stream sniping'],
        },
        {
          code: 'GEN-5',
          slug: 'powergaming',
          title: 'No powergaming',
          description:
            'You do not get to decide what happens to somebody else. Forcing an outcome, inventing abilities, or refusing to let a scene go against you is powergaming.',
          severity: 'SERIOUS',
          aliases: ['Powergaming', 'power gaming'],
        },
      ],
    },
    {
      slug: 'violence',
      name: 'Violence and conflict',
      description: 'When force is allowed, and what has to be true before it is.',
      rules: [
        {
          code: 'VIO-1',
          slug: 'rdm',
          title: 'No random deathmatch',
          description:
            'Killing a player requires a reason your character could explain afterwards. Violence without roleplay preceding it is RDM, and it is the fastest way out of the city.',
          examples: 'Shooting a stranger at a fuel station because they looked at you.',
          severity: 'ZERO_TOLERANCE',
          aliases: ['RDM', 'Random Deathmatch'],
        },
        {
          code: 'VIO-2',
          slug: 'vdm',
          title: 'No vehicle deathmatch',
          description:
            'A car is not a weapon of convenience. Deliberately running players down without roleplay is VDM and is treated exactly as seriously as RDM.',
          severity: 'ZERO_TOLERANCE',
          aliases: ['VDM', 'Vehicle Deathmatch', 'car ramming'],
        },
        {
          code: 'VIO-3',
          slug: 'new-life-rule',
          title: 'New life rule',
          description:
            'When your character goes down and is not revived, they do not remember how it happened and do not return to it. Everything from that scene is gone - the grudge, the location, the faces.',
          severity: 'SERIOUS',
          aliases: ['NLR', 'New Life Rule'],
        },
        {
          code: 'VIO-4',
          slug: 'combat-logging',
          title: 'Do not disconnect to escape',
          description:
            'Leaving the city during an active scene to avoid its outcome is combat logging. If you have to go, say so in character and let the scene resolve.',
          severity: 'SERIOUS',
          aliases: ['combat log', 'alt f4'],
        },
      ],
    },
    {
      slug: 'criminal',
      name: 'Criminal roleplay',
      description: 'The boundaries that keep the underworld interesting instead of exhausting.',
      rules: [
        {
          code: 'CRI-1',
          slug: 'hostage-value',
          title: 'A hostage is a person, not a shield',
          description:
            'Taking a hostage requires roleplay before, during and after. They are a character with a life, not an object that makes police back off.',
          severity: 'SERIOUS',
        },
        {
          code: 'CRI-2',
          slug: 'robbery-reason',
          title: 'Robbery needs a reason and a build-up',
          description:
            'Approach, demand, threat, outcome. A robbery that begins and ends in four seconds is not roleplay, it is a transaction.',
          severity: 'STANDARD',
        },
        {
          code: 'CRI-3',
          slug: 'no-cop-baiting',
          title: 'Do not bait police for the chase',
          description:
            'Provoking a pursuit purely to have one wastes everyone’s evening. Criminal activity should have a purpose your character would recognise.',
          severity: 'STANDARD',
          aliases: ['cop baiting'],
        },
      ],
    },
    {
      slug: 'accounts',
      name: 'Accounts and fairness',
      description: 'Rules about the player rather than the character.',
      rules: [
        {
          code: 'ACC-1',
          slug: 'one-account',
          title: 'One account per person',
          description:
            'Your Xenon account is tied to your Discord and your game identifiers. Alternate accounts to avoid a sanction or to gain an advantage are removed on sight.',
          severity: 'ZERO_TOLERANCE',
        },
        {
          code: 'ACC-2',
          slug: 'no-cheating',
          title: 'No modifications that change the game',
          description:
            'Menus, injectors, and anything that alters what the server believes is happening are an immediate and permanent removal.',
          severity: 'ZERO_TOLERANCE',
          aliases: ['cheating', 'modding', 'exploits'],
        },
        {
          code: 'ACC-3',
          slug: 'exploits',
          title: 'Report bugs, do not farm them',
          description:
            'Finding a bug is fine and useful. Using one is not. Report it through a ticket and it gets fixed.',
          severity: 'SERIOUS',
        },
      ],
    },
  ];

async function seedRules(): Promise<number> {
  let count = 0;

  for (const [categoryIndex, category] of ruleCategories.entries()) {
    const row = await prisma.ruleCategory.upsert({
      where: { slug: category.slug },
      create: {
        slug: category.slug,
        name: category.name,
        description: category.description,
        sortOrder: categoryIndex,
      },
      update: { name: category.name, description: category.description, sortOrder: categoryIndex },
    });

    for (const [ruleIndex, rule] of category.rules.entries()) {
      const saved = await prisma.rule.upsert({
        where: { code: rule.code },
        create: {
          categoryId: row.id,
          code: rule.code,
          slug: rule.slug,
          title: rule.title,
          description: rule.description,
          examples: rule.examples ?? null,
          severity: rule.severity,
          aliases: rule.aliases ?? [],
          isDevelopmentFixture: true,
          status: 'PUBLISHED',
          sortOrder: ruleIndex,
          publishedAt: new Date(),
        },
        update: {
          categoryId: row.id,
          title: rule.title,
          description: rule.description,
          examples: rule.examples ?? null,
          severity: rule.severity,
          aliases: rule.aliases ?? [],
          isDevelopmentFixture: true,
          status: 'PUBLISHED',
          sortOrder: ruleIndex,
        },
      });

      const latest = await prisma.ruleRevision.findFirst({
        where: { ruleId: saved.id },
        orderBy: { version: 'desc' },
      });

      if (latest === null) {
        await prisma.ruleRevision.create({
          data: {
            ruleId: saved.id,
            version: 1,
            title: saved.title,
            description: saved.description,
            examples: saved.examples,
            severity: saved.severity,
            changeNote: 'Initial development fixture',
          },
        });
      }

      count += 1;
    }
  }

  // Publish a ruleset so the rules-acceptance step of onboarding has something
  // to accept. Without one, every account is stuck before FiveM linking.
  const existing = await prisma.ruleSet.findFirst({ where: { isCurrent: true } });
  if (existing === null) {
    const revisions = await prisma.ruleRevision.findMany({ select: { id: true } });
    await prisma.ruleSet.create({
      data: {
        version: 1,
        revisionIds: revisions.map((revision) => revision.id),
        isCurrent: true,
        note: 'Development fixture ruleset',
      },
    });
  }

  return count;
}

// --- Departments -------------------------------------------------------------

const departments = [
  {
    slug: 'police',
    name: 'Xenon Police Department',
    shortName: 'XPD',
    tagline: 'Order is a negotiation, and somebody has to hold the line.',
    description:
      'Patrol, respond, investigate and testify. The XPD is the most visible organisation in the city, which means every decision an officer makes is made in public.',
    recruitmentState: 'OPEN' as const,
    requirements: [
      'Whitelisted and in good standing',
      'Comfortable with long-form roleplay and radio discipline',
      'Willing to complete academy training before patrol',
    ],
    accentColour: '#4A9EFF',
    sortOrder: 0,
  },
  {
    slug: 'ems',
    name: 'Xenon Emergency Medical Services',
    shortName: 'EMS',
    tagline: 'Somebody has to be calm.',
    description:
      'EMS arrives after the worst has already happened. Triage, treatment, transport, and holding a scene together while everyone else is shouting.',
    recruitmentState: 'OPEN' as const,
    requirements: [
      'Whitelisted and in good standing',
      'Patience, and a steady voice on the radio',
      'Ride-along before a solo shift',
    ],
    accentColour: '#FF5A5A',
    sortOrder: 1,
  },
];

async function seedDepartments(): Promise<number> {
  for (const department of departments) {
    await prisma.department.upsert({
      where: { slug: department.slug },
      create: {
        ...department,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        body: `<p>${department.description}</p><h2>How we work</h2><p>Development fixture content. Replace this from the control centre before launch.</p>`,
      },
      update: { ...department, status: 'PUBLISHED' },
    });
  }
  // Archive departments dropped from the fixture list; rows may still be referenced.
  await prisma.department.updateMany({
    where: { slug: { notIn: departments.map((department) => department.slug) } },
    data: { status: 'ARCHIVED' },
  });
  return departments.length;
}

// --- Application templates ---------------------------------------------------

interface QuestionFixture {
  key: string;
  type:
    | 'SHORT_TEXT'
    | 'LONG_TEXT'
    | 'NUMBER'
    | 'SELECT'
    | 'RADIO'
    | 'BOOLEAN'
    | 'ACKNOWLEDGEMENT'
    | 'MULTI_SELECT';
  label: string;
  helpText?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  options?: { value: string; label: string }[];
  visibleWhenQuestionKey?: string;
  visibleWhenOperator?: 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'IS_EMPTY' | 'IS_NOT_EMPTY';
  visibleWhenValue?: string;
  staffOnly?: boolean;
}

interface SectionFixture {
  title: string;
  description: string;
  questions: QuestionFixture[];
}

const whitelistSections: SectionFixture[] = [
  {
    title: 'About you',
    description: 'The person behind the character. None of this is shown publicly.',
    questions: [
      {
        key: 'age',
        type: 'NUMBER',
        label: 'How old are you?',
        helpText: 'You must be 16 or older to play in Xenon.',
        required: true,
        minValue: 16,
        maxValue: 99,
      },
      {
        key: 'timezone',
        type: 'SELECT',
        label: 'Which timezone do you usually play in?',
        required: true,
        options: [
          { value: 'asia_colombo', label: 'Sri Lanka (IST)' },
          { value: 'asia_other', label: 'Elsewhere in Asia' },
          { value: 'europe', label: 'Europe' },
          { value: 'americas', label: 'Americas' },
          { value: 'other', label: 'Somewhere else' },
        ],
      },
      {
        key: 'experience',
        type: 'RADIO',
        label: 'How much roleplay experience do you have?',
        required: true,
        options: [
          { value: 'none', label: 'This would be my first server' },
          { value: 'some', label: 'Some - a few months' },
          { value: 'lots', label: 'A lot - years' },
        ],
      },
      {
        key: 'previous_servers',
        type: 'LONG_TEXT',
        label: 'Where have you played before, and why did you leave?',
        helpText: 'Honesty here helps us, and it has never hurt an application.',
        required: true,
        minLength: 60,
        maxLength: 1500,
        visibleWhenQuestionKey: 'experience',
        visibleWhenOperator: 'NOT_EQUALS',
        visibleWhenValue: 'none',
      },
    ],
  },
  {
    title: 'Your character',
    description: 'Who arrives in Xenon, and what are they hoping for?',
    questions: [
      {
        key: 'character_name',
        type: 'SHORT_TEXT',
        label: 'Character name',
        placeholder: 'First and last',
        required: true,
        minLength: 3,
        maxLength: 60,
      },
      {
        key: 'character_backstory',
        type: 'LONG_TEXT',
        label: 'Tell us about them',
        helpText:
          'Where are they from, what do they want, and what are they afraid of? Write it as a person, not a character sheet.',
        required: true,
        minLength: 400,
        maxLength: 5000,
      },
      {
        key: 'character_first_day',
        type: 'LONG_TEXT',
        label: 'Describe their first day in the city',
        helpText: 'What do they do, and who do they meet?',
        required: true,
        minLength: 200,
        maxLength: 3000,
      },
      {
        key: 'interests',
        type: 'MULTI_SELECT',
        label: 'What kind of roleplay are you drawn to?',
        helpText: 'Pick up to three. This does not limit you.',
        required: true,
        maxLength: 3,
        options: [
          { value: 'civilian', label: 'Civilian life' },
          { value: 'police', label: 'Law enforcement' },
          { value: 'ems', label: 'Emergency medical' },
          { value: 'business', label: 'Business and trade' },
          { value: 'criminal', label: 'Criminal' },
          { value: 'legal', label: 'Courts and law' },
        ],
      },
    ],
  },
  {
    title: 'The rules',
    description: 'Short answers. We are checking understanding, not memory.',
    questions: [
      {
        key: 'define_rdm',
        type: 'LONG_TEXT',
        label: 'In your own words, what is RDM?',
        required: true,
        minLength: 60,
        maxLength: 800,
      },
      {
        key: 'define_nlr',
        type: 'LONG_TEXT',
        label: 'What does the new life rule mean for your character?',
        required: true,
        minLength: 60,
        maxLength: 800,
      },
      {
        key: 'scenario_powergaming',
        type: 'LONG_TEXT',
        label:
          'Another player refuses to let your robbery succeed and claims they have a hidden weapon. What do you do?',
        required: true,
        minLength: 80,
        maxLength: 1200,
      },
      {
        key: 'rules_ack',
        type: 'ACKNOWLEDGEMENT',
        label: 'I have read the Xenon rulebook and accept it in full.',
        required: true,
      },
    ],
  },
  {
    title: 'Reviewer notes',
    description: 'Only staff can see this section.',
    questions: [
      {
        key: 'staff_flag',
        type: 'SHORT_TEXT',
        label: 'Internal flag',
        helpText: 'Free text for the reviewing team.',
        staffOnly: true,
      },
    ],
  },
];

const policeSections: SectionFixture[] = [
  {
    title: 'Eligibility',
    description: 'Department applications are open to whitelisted players only.',
    questions: [
      {
        key: 'time_in_city',
        type: 'NUMBER',
        label: 'Roughly how many hours have you played in Xenon?',
        required: true,
        minValue: 0,
        maxValue: 10000,
      },
      {
        key: 'prior_department',
        type: 'BOOLEAN',
        label: 'Have you served in a law enforcement department before?',
        required: true,
      },
      {
        key: 'prior_department_detail',
        type: 'LONG_TEXT',
        label: 'Where, and in what role?',
        required: true,
        minLength: 40,
        maxLength: 1200,
        visibleWhenQuestionKey: 'prior_department',
        visibleWhenOperator: 'EQUALS',
        visibleWhenValue: 'true',
      },
    ],
  },
  {
    title: 'Judgement',
    description: 'There are no trick questions here.',
    questions: [
      {
        key: 'use_of_force',
        type: 'LONG_TEXT',
        label: 'When is it right to draw your weapon, and when is it not?',
        required: true,
        minLength: 150,
        maxLength: 2000,
      },
      {
        key: 'pursuit_call',
        type: 'LONG_TEXT',
        label: 'A pursuit enters a crowded area. Walk us through your decision.',
        required: true,
        minLength: 150,
        maxLength: 2000,
      },
      {
        key: 'integrity_ack',
        type: 'ACKNOWLEDGEMENT',
        label: 'I understand that the badge is held to a higher standard than the street.',
        required: true,
      },
    ],
  },
];

async function seedTemplate(
  slug: string,
  name: string,
  prefix: string,
  sections: SectionFixture[],
  options: {
    summary: string;
    description: string;
    grantsWhitelist?: boolean;
    requiresFivemLink?: boolean;
    departmentSlug?: string;
    interviewRequired?: boolean;
    grantRoleKeys?: string[];
    sortOrder: number;
  },
): Promise<void> {
  const department =
    options.departmentSlug === undefined
      ? null
      : await prisma.department.findUnique({ where: { slug: options.departmentSlug } });

  const template = await prisma.applicationTemplate.upsert({
    where: { slug },
    create: {
      slug,
      name,
      publicIdPrefix: prefix,
      summary: options.summary,
      description: options.description,
      departmentId: department?.id ?? null,
      status: 'OPEN',
      grantsWhitelist: options.grantsWhitelist ?? false,
      requiresFivemLink: options.requiresFivemLink ?? false,
      requiresGuildMember: false,
      requiresRulesAccepted: true,
      interviewRequired: options.interviewRequired ?? false,
      grantRoleKeys: options.grantRoleKeys ?? [],
      rejectionCooldownDays: 14,
      expiryDays: 30,
      sortOrder: options.sortOrder,
    },
    update: {
      name,
      summary: options.summary,
      description: options.description,
      status: 'OPEN',
      departmentId: department?.id ?? null,
    },
  });

  for (const [sectionIndex, section] of sections.entries()) {
    const existingSection = await prisma.applicationSection.findFirst({
      where: { templateId: template.id, title: section.title },
    });

    const sectionRow =
      existingSection ??
      (await prisma.applicationSection.create({
        data: {
          templateId: template.id,
          title: section.title,
          description: section.description,
          sortOrder: sectionIndex,
        },
      }));

    for (const [questionIndex, question] of section.questions.entries()) {
      const saved = await prisma.applicationQuestion.upsert({
        where: { sectionId_key: { sectionId: sectionRow.id, key: question.key } },
        create: {
          sectionId: sectionRow.id,
          key: question.key,
          type: question.type,
          label: question.label,
          helpText: question.helpText ?? null,
          placeholder: question.placeholder ?? null,
          required: question.required ?? false,
          sortOrder: questionIndex,
          minLength: question.minLength ?? null,
          maxLength: question.maxLength ?? null,
          minValue: question.minValue ?? null,
          maxValue: question.maxValue ?? null,
          staffOnly: question.staffOnly ?? false,
          visibleWhenQuestionKey: question.visibleWhenQuestionKey ?? null,
          visibleWhenOperator: question.visibleWhenOperator ?? null,
          visibleWhenValue: question.visibleWhenValue ?? null,
        },
        update: {
          label: question.label,
          helpText: question.helpText ?? null,
          sortOrder: questionIndex,
        },
      });

      if (question.options !== undefined) {
        for (const [optionIndex, option] of question.options.entries()) {
          await prisma.applicationQuestionOption.upsert({
            where: { questionId_value: { questionId: saved.id, value: option.value } },
            create: {
              questionId: saved.id,
              value: option.value,
              label: option.label,
              sortOrder: optionIndex,
            },
            update: { label: option.label, sortOrder: optionIndex },
          });
        }
      }
    }
  }
}

// --- News --------------------------------------------------------------------

const articles = [
  {
    slug: 'the-city-opens',
    title: 'The city opens',
    excerpt:
      'Xenon is live. Here is what the first month looks like, and what we are asking of everybody who walks in.',
    category: 'Announcement',
    isPinned: true,
    body: '<p>Development fixture article. Replace this from the control centre.</p><h2>What to expect</h2><p>The first weeks of a city are the ones that set its tone. Play carefully, play consistently, and give other people room to finish their scenes.</p><blockquote>Your actions create your reputation.</blockquote>',
  },
  {
    slug: 'rulebook-v1',
    title: 'Rulebook v1 is published',
    excerpt: 'Every rule now has an identifier, an example and a version. Here is how to use it.',
    category: 'Rules',
    isPinned: false,
    body: '<p>Development fixture article.</p><p>The rulebook is searchable by shorthand - typing <code>RDM</code> finds the rule even though those letters do not appear in its title.</p>',
  },
  {
    slug: 'department-applications-open',
    title: 'Department applications are open',
    excerpt: 'XPD and EMS are both recruiting. DOJ remains invite only for now.',
    category: 'Departments',
    isPinned: false,
    body: '<p>Development fixture article.</p><p>Applications are read by a person and answered properly, which takes time. You will get a real response either way.</p>',
  },
  {
    slug: 'a-note-on-criminal-roleplay',
    title: 'A note on criminal roleplay',
    excerpt: 'The underworld works when it is structured. Here is what we expect from crews.',
    category: 'Community',
    isPinned: false,
    body: '<p>Development fixture article.</p><p>Crews with identity, history and something to lose make better stories than crews with better weapons.</p>',
  },
];

async function seedArticles(): Promise<number> {
  for (const [index, article] of articles.entries()) {
    await prisma.article.upsert({
      where: { slug: article.slug },
      create: {
        ...article,
        status: 'PUBLISHED',
        // Spaced a few days apart so the news index has a believable ordering.
        publishedAt: new Date(Date.now() - index * 3 * 86_400_000),
      },
      update: { title: article.title, excerpt: article.excerpt, body: article.body },
    });
  }
  return articles.length;
}

// --- Entry point -------------------------------------------------------------

async function main(): Promise<void> {
  await seedSettings();
  await seedServer();
  const rules = await seedRules();
  const departmentCount = await seedDepartments();

  await seedTemplate('whitelist', 'General Whitelist', 'WL', whitelistSections, {
    summary: 'The way into the city. Everyone starts here.',
    description:
      'Our main application. It asks about you, about your character, and about how you read the rules. Set aside thirty to sixty minutes - your progress saves as you type.',
    grantsWhitelist: true,
    sortOrder: 0,
  });

  await seedTemplate('police', 'Police Department', 'PD', policeSections, {
    summary: 'Join the XPD. Whitelisted players only.',
    description:
      'Department intake for the Xenon Police Department. Expect an interview if your application progresses.',
    departmentSlug: 'police',
    interviewRequired: true,
    requiresFivemLink: true,
    sortOrder: 1,
  });

  const articleCount = await seedArticles();
  const userCount = await seedDevFixtureUsers(prisma);

  /* eslint-disable no-console -- a seed script's output is its result */
  console.log(
    [
      '',
      '  DEVELOPMENT FIXTURES LOADED',
      '  ---------------------------',
      `  ${String(rules)} rules across ${String(ruleCategories.length)} categories (ruleset v1 published)`,
      `  ${String(departmentCount)} departments`,
      '  2 application templates (whitelist, police)',
      `  ${String(articleCount)} news articles`,
      '  1 game server (MOCK adapter) with a status snapshot',
      `  ${String(userCount)} fixture accounts: dev_player, dev_staff (owner)`,
      '',
      '  This content is INVENTED FOR DEVELOPMENT. It is not XenonRP’s real',
      '  departments, rules or questions. Replace all of it from /control',
      '  before showing the site to anybody.',
      '',
      '  The control centre shows a standing banner while dev.fixturesLoaded',
      '  is set. Clear that setting once the real content is in.',
      '',
    ].join('\n'),
  );
  /* eslint-enable no-console */
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
