import { describe, expect, it } from 'vitest';

import {
  type AnswerMap,
  isAnswerEmpty,
  isQuestionVisible,
  type QuestionDefinition,
  type QuestionTypeName,
  submissionProgress,
  validateAnswer,
  validateSubmission,
  visibleQuestions,
} from './question';

function question(
  key: string,
  type: QuestionTypeName,
  overrides: Partial<QuestionDefinition> = {},
): QuestionDefinition {
  return {
    id: key,
    key,
    type,
    label: key,
    required: false,
    minLength: null,
    maxLength: null,
    minValue: null,
    maxValue: null,
    pattern: null,
    staffOnly: false,
    visibleWhenQuestionKey: null,
    visibleWhenOperator: null,
    visibleWhenValue: null,
    maxFiles: null,
    maxFileSizeBytes: null,
    allowedMimeTypes: [],
    options: [],
    ...overrides,
  };
}

describe('isAnswerEmpty', () => {
  it('treats whitespace-only text as empty', () => {
    const q = question('why', 'LONG_TEXT');
    expect(isAnswerEmpty(q, { textValue: '   \n ' })).toBe(true);
    expect(isAnswerEmpty(q, { textValue: 'because' })).toBe(false);
  });

  it('treats a false boolean as answered, not as empty', () => {
    // The distinction matters: "no" is an answer, and a required yes/no
    // question must accept it rather than demanding "yes".
    const q = question('agree', 'BOOLEAN');
    expect(isAnswerEmpty(q, { booleanValue: false })).toBe(false);
    expect(isAnswerEmpty(q, {})).toBe(true);
  });

  it('treats zero as answered for a number question', () => {
    const q = question('age', 'NUMBER');
    expect(isAnswerEmpty(q, { numberValue: 0 })).toBe(false);
  });

  it('treats an empty choice list as empty', () => {
    const q = question('pick', 'MULTI_SELECT');
    expect(isAnswerEmpty(q, { choiceValues: [] })).toBe(true);
    expect(isAnswerEmpty(q, { choiceValues: ['a'] })).toBe(false);
  });
});

describe('validateAnswer', () => {
  it('requires an answer only when the question is required', () => {
    expect(validateAnswer(question('a', 'SHORT_TEXT'), undefined)).toHaveLength(0);
    expect(validateAnswer(question('a', 'SHORT_TEXT', { required: true }), undefined)).toHaveLength(
      1,
    );
  });

  it('enforces text length bounds', () => {
    const q = question('story', 'LONG_TEXT', { minLength: 10, maxLength: 20 });
    expect(validateAnswer(q, { textValue: 'short' })[0]).toMatch(/at least 10/);
    expect(validateAnswer(q, { textValue: 'x'.repeat(30) })[0]).toMatch(/20 characters or fewer/);
    expect(validateAnswer(q, { textValue: 'just about right' })).toHaveLength(0);
  });

  it('enforces numeric bounds', () => {
    const q = question('age', 'NUMBER', { minValue: 16, maxValue: 99 });
    expect(validateAnswer(q, { numberValue: 12 })[0]).toMatch(/at least 16/);
    expect(validateAnswer(q, { numberValue: 120 })[0]).toMatch(/at most 99/);
    expect(validateAnswer(q, { numberValue: 24 })).toHaveLength(0);
  });

  it('rejects a choice that is not in the option set', () => {
    // This is the tamper case: the rendered form could not have produced it.
    const q = question('dept', 'SELECT', {
      options: [
        { value: 'pd', label: 'Police' },
        { value: 'ems', label: 'EMS' },
      ],
    });
    expect(validateAnswer(q, { choiceValues: ['doj'] })[0]).toMatch(/no longer available/);
    expect(validateAnswer(q, { choiceValues: ['pd'] })).toHaveLength(0);
  });

  it('rejects more than one choice on a single-select question', () => {
    const q = question('dept', 'SELECT', {
      options: [
        { value: 'pd', label: 'Police' },
        { value: 'ems', label: 'EMS' },
      ],
    });
    expect(validateAnswer(q, { choiceValues: ['pd', 'ems'] })).toContain('Choose one option.');
  });

  it('demands a positive acknowledgement, not merely a value', () => {
    const q = question('rules', 'ACKNOWLEDGEMENT', { required: true });
    expect(validateAnswer(q, { booleanValue: false })).toHaveLength(1);
    expect(validateAnswer(q, { booleanValue: true })).toHaveLength(0);
  });

  it('rejects an unparseable date', () => {
    const q = question('dob', 'DATE');
    expect(validateAnswer(q, { dateValue: 'not-a-date' })[0]).toMatch(/valid date/);
    expect(validateAnswer(q, { dateValue: '1998-04-12' })).toHaveLength(0);
  });

  it('ignores a malformed stored pattern rather than blocking the applicant', () => {
    // A broken regex is the builder's mistake; punishing the applicant for it
    // would make a template edit able to lock everyone out of submitting.
    const q = question('handle', 'SHORT_TEXT', { pattern: '([unclosed' });
    expect(validateAnswer(q, { textValue: 'anything' })).toHaveLength(0);
  });

  it('caps the number of attachments', () => {
    const q = question('proof', 'IMAGE', { maxFiles: 2 });
    expect(validateAnswer(q, { mediaIds: ['a', 'b', 'c'] })[0]).toMatch(/at most 2/);
  });
});

describe('conditional visibility', () => {
  const trigger = question('has_experience', 'BOOLEAN');
  const dependant = question('experience_detail', 'LONG_TEXT', {
    required: true,
    visibleWhenQuestionKey: 'has_experience',
    visibleWhenOperator: 'EQUALS',
    visibleWhenValue: 'true',
  });
  const all = [trigger, dependant];

  it('hides the dependant when the condition is unmet', () => {
    const answers: AnswerMap = { has_experience: { booleanValue: false } };
    expect(isQuestionVisible(dependant, all, answers)).toBe(false);
    expect(visibleQuestions(all, answers)).toHaveLength(1);
  });

  it('shows the dependant when the condition is met', () => {
    const answers: AnswerMap = { has_experience: { booleanValue: true } };
    expect(isQuestionVisible(dependant, all, answers)).toBe(true);
  });

  it('does not require an answer to a hidden question', () => {
    const answers: AnswerMap = { has_experience: { booleanValue: false } };
    expect(validateSubmission(all, answers)).toEqual({});
  });

  it('requires an answer once the branch is taken', () => {
    const answers: AnswerMap = { has_experience: { booleanValue: true } };
    expect(Object.keys(validateSubmission(all, answers))).toEqual(['experience_detail']);
  });

  it('shows a question whose controlling question does not exist', () => {
    // A builder mistake should surface as a visible extra field rather than as
    // a silently skipped requirement.
    const orphan = question('orphan', 'SHORT_TEXT', {
      visibleWhenQuestionKey: 'missing',
      visibleWhenOperator: 'EQUALS',
      visibleWhenValue: 'x',
    });
    expect(isQuestionVisible(orphan, [orphan], {})).toBe(true);
  });

  it('hides a question whose controlling question is itself hidden', () => {
    const second = question('second', 'SHORT_TEXT', {
      visibleWhenQuestionKey: 'experience_detail',
      visibleWhenOperator: 'IS_NOT_EMPTY',
    });
    const answers: AnswerMap = { has_experience: { booleanValue: false } };
    expect(isQuestionVisible(second, [...all, second], answers)).toBe(false);
  });

  it('matches a single selection inside a multi-select with CONTAINS', () => {
    const multi = question('interests', 'MULTI_SELECT', {
      options: [
        { value: 'crime', label: 'Crime' },
        { value: 'legal', label: 'Legal' },
      ],
    });
    const dep = question('crime_detail', 'SHORT_TEXT', {
      visibleWhenQuestionKey: 'interests',
      visibleWhenOperator: 'CONTAINS',
      visibleWhenValue: 'crime',
    });
    expect(
      isQuestionVisible(dep, [multi, dep], { interests: { choiceValues: ['legal', 'crime'] } }),
    ).toBe(true);
    expect(isQuestionVisible(dep, [multi, dep], { interests: { choiceValues: ['legal'] } })).toBe(
      false,
    );
  });
});

describe('validateSubmission', () => {
  it('never asks the applicant to answer a staff-only question', () => {
    const questions = [question('screening', 'SHORT_TEXT', { required: true, staffOnly: true })];
    expect(validateSubmission(questions, {})).toEqual({});
  });
});

describe('submissionProgress', () => {
  const questions = [
    question('a', 'SHORT_TEXT', { required: true }),
    question('b', 'SHORT_TEXT', { required: true }),
    question('c', 'SHORT_TEXT'),
  ];

  it('counts only required, visible, applicant-facing questions', () => {
    expect(submissionProgress(questions, {})).toEqual({ answered: 0, total: 2, ratio: 0 });
    expect(submissionProgress(questions, { a: { textValue: 'x' } })).toEqual({
      answered: 1,
      total: 2,
      ratio: 0.5,
    });
  });

  it('reports a form with no required questions as complete', () => {
    expect(submissionProgress([question('c', 'SHORT_TEXT')], {}).ratio).toBe(1);
  });
});
