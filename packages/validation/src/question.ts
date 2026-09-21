/**
 * Application answer validation.
 *
 * Kept in a pure package with no database edge so the identical rules run in
 * three places: the browser (instant feedback), the server action (the only one
 * that counts) and the test suite. A question is described by a plain interface
 * rather than by the Prisma row type, which is what lets this package stay free
 * of `@xenon/database`.
 */

export type QuestionTypeName =
  | 'SHORT_TEXT'
  | 'LONG_TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'RADIO'
  | 'BOOLEAN'
  | 'CHECKBOX'
  | 'ACKNOWLEDGEMENT'
  | 'FILE'
  | 'IMAGE'
  | 'CHARACTER_SELECT';

export type ConditionOperatorName =
  'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'IS_EMPTY' | 'IS_NOT_EMPTY';

export interface QuestionOptionDefinition {
  readonly value: string;
  readonly label: string;
}

export interface QuestionDefinition {
  readonly id: string;
  readonly key: string;
  readonly type: QuestionTypeName;
  readonly label: string;
  readonly required: boolean;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly pattern: string | null;
  readonly staffOnly: boolean;
  readonly visibleWhenQuestionKey: string | null;
  readonly visibleWhenOperator: ConditionOperatorName | null;
  readonly visibleWhenValue: string | null;
  readonly maxFiles: number | null;
  readonly maxFileSizeBytes: number | null;
  readonly allowedMimeTypes: readonly string[];
  readonly options: readonly QuestionOptionDefinition[];
}

/** The stored shape of one answer. Exactly one branch is meaningful per type. */
export interface AnswerValue {
  readonly textValue?: string | null;
  readonly numberValue?: number | null;
  readonly booleanValue?: boolean | null;
  readonly dateValue?: Date | string | null;
  readonly choiceValues?: readonly string[];
  readonly mediaIds?: readonly string[];
}

export type AnswerMap = Readonly<Record<string, AnswerValue | undefined>>;

const CHOICE_TYPES = new Set<QuestionTypeName>(['SELECT', 'MULTI_SELECT', 'RADIO', 'CHECKBOX']);
const MEDIA_TYPES = new Set<QuestionTypeName>(['FILE', 'IMAGE']);
const TEXT_TYPES = new Set<QuestionTypeName>(['SHORT_TEXT', 'LONG_TEXT', 'CHARACTER_SELECT']);

/** True when the answer carries nothing the applicant actually filled in. */
export function isAnswerEmpty(
  question: QuestionDefinition,
  value: AnswerValue | undefined,
): boolean {
  if (value === undefined) return true;

  if (CHOICE_TYPES.has(question.type)) return (value.choiceValues ?? []).length === 0;
  if (MEDIA_TYPES.has(question.type)) return (value.mediaIds ?? []).length === 0;

  switch (question.type) {
    case 'NUMBER':
      return value.numberValue === null || value.numberValue === undefined;
    case 'DATE':
      return value.dateValue === null || value.dateValue === undefined || value.dateValue === '';
    case 'BOOLEAN':
    case 'ACKNOWLEDGEMENT':
      return value.booleanValue === null || value.booleanValue === undefined;
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
    case 'CHARACTER_SELECT':
    case 'SELECT':
    case 'MULTI_SELECT':
    case 'RADIO':
    case 'CHECKBOX':
    case 'FILE':
    case 'IMAGE':
      return (value.textValue ?? '').trim().length === 0;
  }
}

/** Render an answer as the string the visibility conditions compare against. */
function comparableValue(question: QuestionDefinition, value: AnswerValue | undefined): string {
  if (value === undefined) return '';
  if (CHOICE_TYPES.has(question.type)) return (value.choiceValues ?? []).join(',');
  if (question.type === 'BOOLEAN' || question.type === 'ACKNOWLEDGEMENT') {
    if (value.booleanValue === true) return 'true';
    if (value.booleanValue === false) return 'false';
    return '';
  }
  if (question.type === 'NUMBER') {
    return value.numberValue === null || value.numberValue === undefined
      ? ''
      : String(value.numberValue);
  }
  return (value.textValue ?? '').trim();
}

/**
 * Whether a conditional question should be shown.
 *
 * A question whose controlling question is missing is shown rather than hidden:
 * a builder mistake should surface as a visible extra field, never as a
 * silently skipped requirement.
 */
export function isQuestionVisible(
  question: QuestionDefinition,
  allQuestions: readonly QuestionDefinition[],
  answers: AnswerMap,
): boolean {
  const controllingKey = question.visibleWhenQuestionKey;
  const operator = question.visibleWhenOperator;
  if (controllingKey === null || operator === null) return true;

  const controlling = allQuestions.find((candidate) => candidate.key === controllingKey);
  if (controlling === undefined) return true;

  // A condition on a hidden question is itself unreachable; hide the dependant
  // too rather than evaluating against an answer the applicant never saw.
  if (controlling !== question && !isQuestionVisible(controlling, allQuestions, answers)) {
    return false;
  }

  const actual = comparableValue(controlling, answers[controllingKey]);
  const expected = question.visibleWhenValue ?? '';

  switch (operator) {
    case 'EQUALS':
      return actual === expected;
    case 'NOT_EQUALS':
      return actual !== expected;
    case 'CONTAINS':
      return actual.split(',').includes(expected) || actual.includes(expected);
    case 'IS_EMPTY':
      return actual.length === 0;
    case 'IS_NOT_EMPTY':
      return actual.length > 0;
  }
}

/** Questions the applicant can actually see, given what they have answered. */
export function visibleQuestions(
  questions: readonly QuestionDefinition[],
  answers: AnswerMap,
): readonly QuestionDefinition[] {
  return questions.filter((question) => isQuestionVisible(question, questions, answers));
}

export type FieldErrors = Record<string, string[]>;

/** Validate one answer. Returns the messages for that question, empty if fine. */
export function validateAnswer(
  question: QuestionDefinition,
  value: AnswerValue | undefined,
): readonly string[] {
  const messages: string[] = [];

  if (isAnswerEmpty(question, value)) {
    if (question.required) {
      messages.push(
        question.type === 'ACKNOWLEDGEMENT'
          ? 'You must acknowledge this to continue.'
          : 'This answer is required.',
      );
    }
    return messages;
  }

  if (TEXT_TYPES.has(question.type)) {
    const text = (value?.textValue ?? '').trim();
    if (question.minLength !== null && text.length < question.minLength) {
      messages.push(`Needs at least ${String(question.minLength)} characters.`);
    }
    if (question.maxLength !== null && text.length > question.maxLength) {
      messages.push(`Must be ${String(question.maxLength)} characters or fewer.`);
    }
    if (question.pattern !== null) {
      // A malformed pattern is a builder error, not an applicant error: treat
      // the answer as acceptable rather than blocking a submission on it.
      try {
        if (!new RegExp(question.pattern).test(text)) {
          messages.push('That answer is not in the expected format.');
        }
      } catch {
        /* ignore an invalid stored pattern */
      }
    }
  }

  if (question.type === 'NUMBER') {
    const numeric = value?.numberValue;
    if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
      messages.push('Enter a number.');
    } else {
      if (question.minValue !== null && numeric < question.minValue) {
        messages.push(`Must be at least ${String(question.minValue)}.`);
      }
      if (question.maxValue !== null && numeric > question.maxValue) {
        messages.push(`Must be at most ${String(question.maxValue)}.`);
      }
    }
  }

  if (question.type === 'DATE') {
    const raw = value?.dateValue;
    const parsed = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) {
      messages.push('Enter a valid date.');
    }
  }

  if (question.type === 'ACKNOWLEDGEMENT' && value?.booleanValue !== true) {
    messages.push('You must acknowledge this to continue.');
  }

  if (CHOICE_TYPES.has(question.type)) {
    const chosen = value?.choiceValues ?? [];
    const permitted = new Set(question.options.map((option) => option.value));
    // Every choice question has a closed option set, so a value outside it came
    // from a tampered request rather than from the rendered form.
    if (chosen.some((choice) => !permitted.has(choice))) {
      messages.push('That option is no longer available.');
    }

    const single = question.type === 'SELECT' || question.type === 'RADIO';
    if (single && chosen.length > 1) {
      messages.push('Choose one option.');
    }
    if (!single) {
      if (question.minLength !== null && chosen.length < question.minLength) {
        messages.push(`Choose at least ${String(question.minLength)}.`);
      }
      if (question.maxLength !== null && chosen.length > question.maxLength) {
        messages.push(`Choose at most ${String(question.maxLength)}.`);
      }
    }
  }

  if (MEDIA_TYPES.has(question.type)) {
    const media = value?.mediaIds ?? [];
    if (question.maxFiles !== null && media.length > question.maxFiles) {
      messages.push(`Attach at most ${String(question.maxFiles)} files.`);
    }
  }

  return messages;
}

/**
 * Validate a whole submission.
 *
 * Only visible questions are checked: a required field inside a branch the
 * applicant never took must not block them, and staff-only questions are not
 * theirs to answer.
 */
export function validateSubmission(
  questions: readonly QuestionDefinition[],
  answers: AnswerMap,
): FieldErrors {
  const errors: FieldErrors = {};

  for (const question of visibleQuestions(questions, answers)) {
    if (question.staffOnly) continue;
    const messages = validateAnswer(question, answers[question.key]);
    if (messages.length > 0) errors[question.key] = [...messages];
  }

  return errors;
}

/** True when a submission has no blocking problems. */
export function isSubmissionComplete(
  questions: readonly QuestionDefinition[],
  answers: AnswerMap,
): boolean {
  return Object.keys(validateSubmission(questions, answers)).length === 0;
}

/**
 * How far through the form the applicant is, as a fraction of required visible
 * questions answered. Drives the progress bar and the resume prompt.
 */
export function submissionProgress(
  questions: readonly QuestionDefinition[],
  answers: AnswerMap,
): { answered: number; total: number; ratio: number } {
  const required = visibleQuestions(questions, answers).filter(
    (question) => question.required && !question.staffOnly,
  );
  const answered = required.filter((question) => !isAnswerEmpty(question, answers[question.key]));
  const total = required.length;

  return {
    answered: answered.length,
    total,
    ratio: total === 0 ? 1 : answered.length / total,
  };
}
