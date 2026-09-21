import type {
  ApplicationAnswer,
  ApplicationQuestion,
  ApplicationQuestionOption,
  ApplicationSection,
} from '@xenon/database';
import type { AnswerMap, AnswerValue, QuestionDefinition } from '@xenon/validation';

/**
 * Turn database rows into the form model the UI and the validator share.
 *
 * `QuestionDefinition` lives in `@xenon/validation`, which has no database
 * dependency, so this module is the single adapter between the two. Without it,
 * every screen would map Prisma rows to validator input in its own slightly
 * different way.
 */

export type QuestionRow = ApplicationQuestion & { options: ApplicationQuestionOption[] };
export type SectionRow = ApplicationSection & { questions: QuestionRow[] };

export interface RenderableQuestion extends QuestionDefinition {
  readonly helpText: string | null;
  readonly placeholder: string | null;
  readonly sortOrder: number;
}

export interface RenderableSection {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly questions: readonly RenderableQuestion[];
}

/** Map one question row, including its options, to the shared definition. */
export function toQuestionDefinition(row: QuestionRow): RenderableQuestion {
  return {
    id: row.id,
    key: row.key,
    type: row.type,
    label: row.label,
    helpText: row.helpText,
    placeholder: row.placeholder,
    required: row.required,
    sortOrder: row.sortOrder,
    minLength: row.minLength,
    maxLength: row.maxLength,
    minValue: row.minValue,
    maxValue: row.maxValue,
    pattern: row.pattern,
    staffOnly: row.staffOnly,
    visibleWhenQuestionKey: row.visibleWhenQuestionKey,
    visibleWhenOperator: row.visibleWhenOperator,
    visibleWhenValue: row.visibleWhenValue,
    maxFiles: row.maxFiles,
    maxFileSizeBytes: row.maxFileSizeBytes,
    allowedMimeTypes: row.allowedMimeTypes,
    options: [...row.options]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((option) => ({ value: option.value, label: option.label })),
  };
}

/**
 * Build the section list an applicant sees.
 *
 * Staff-only questions are removed here rather than hidden in the component:
 * a question the applicant cannot answer must not reach their browser at all,
 * because the internal wording of a screening question is not theirs to read.
 */
export function toRenderableSections(
  sections: readonly SectionRow[],
  options: { includeStaffOnly: boolean },
): readonly RenderableSection[] {
  return (
    [...sections]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        sortOrder: section.sortOrder,
        questions: [...section.questions]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .filter((question) => options.includeStaffOnly || !question.staffOnly)
          .map(toQuestionDefinition),
      }))
      // A section whose only questions were staff-only would render as an empty
      // heading, which reads as a loading bug.
      .filter((section) => section.questions.length > 0)
  );
}

/** Flatten sections to the question list the validator expects. */
export function flattenQuestions(
  sections: readonly RenderableSection[],
): readonly RenderableQuestion[] {
  return sections.flatMap((section) => section.questions);
}

export type AnswerRow = ApplicationAnswer & { question: { key: string } };

/** Index stored answers by question key. */
export function toAnswerMap(answers: readonly AnswerRow[]): AnswerMap {
  const map: Record<string, AnswerValue> = {};

  for (const answer of answers) {
    map[answer.question.key] = {
      textValue: answer.textValue,
      numberValue: answer.numberValue,
      booleanValue: answer.booleanValue,
      dateValue: answer.dateValue,
      choiceValues: answer.choiceValues,
      mediaIds: answer.mediaIds,
    };
  }

  return map;
}

/**
 * Split an incoming draft value into the typed columns the schema expects.
 *
 * Deliberately clears the branches the question type does not use, so changing
 * a question from NUMBER to SHORT_TEXT cannot leave a stale number behind that
 * a later validation run would read.
 */
export function toAnswerColumns(
  question: Pick<QuestionDefinition, 'type'>,
  value: AnswerValue,
): {
  textValue: string | null;
  numberValue: number | null;
  booleanValue: boolean | null;
  dateValue: Date | null;
  choiceValues: string[];
  mediaIds: string[];
} {
  const blank = {
    textValue: null,
    numberValue: null,
    booleanValue: null,
    dateValue: null,
    choiceValues: [] as string[],
    mediaIds: [] as string[],
  };

  switch (question.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
    case 'CHARACTER_SELECT':
      return { ...blank, textValue: value.textValue ?? null };

    case 'NUMBER':
      return { ...blank, numberValue: value.numberValue ?? null };

    case 'BOOLEAN':
    case 'ACKNOWLEDGEMENT':
      return { ...blank, booleanValue: value.booleanValue ?? null };

    case 'DATE': {
      if (value.dateValue === null || value.dateValue === undefined || value.dateValue === '') {
        return blank;
      }
      const parsed = value.dateValue instanceof Date ? value.dateValue : new Date(value.dateValue);
      return { ...blank, dateValue: Number.isNaN(parsed.getTime()) ? null : parsed };
    }

    case 'SELECT':
    case 'RADIO':
      // A single-choice question stores at most one value even if the client
      // sent several; the validator reports the tampering separately.
      return { ...blank, choiceValues: (value.choiceValues ?? []).slice(0, 1) };

    case 'MULTI_SELECT':
    case 'CHECKBOX':
      return { ...blank, choiceValues: [...(value.choiceValues ?? [])] };

    case 'FILE':
    case 'IMAGE':
      return { ...blank, mediaIds: [...(value.mediaIds ?? [])] };
  }
}

/** Render an answer as the plain text a review screen or an embed shows. */
export function answerToText(
  question: RenderableQuestion,
  value: AnswerValue | undefined,
): string | null {
  if (value === undefined) return null;

  switch (question.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
    case 'CHARACTER_SELECT':
      return value.textValue ?? null;
    case 'NUMBER':
      return value.numberValue === null || value.numberValue === undefined
        ? null
        : String(value.numberValue);
    case 'BOOLEAN':
    case 'ACKNOWLEDGEMENT':
      if (value.booleanValue === true) return 'Yes';
      if (value.booleanValue === false) return 'No';
      return null;
    case 'DATE': {
      if (!value.dateValue) return null;
      const parsed = value.dateValue instanceof Date ? value.dateValue : new Date(value.dateValue);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
    }
    case 'SELECT':
    case 'RADIO':
    case 'MULTI_SELECT':
    case 'CHECKBOX': {
      const chosen = value.choiceValues ?? [];
      if (chosen.length === 0) return null;
      const labels = chosen.map(
        (choice) => question.options.find((option) => option.value === choice)?.label ?? choice,
      );
      return labels.join(', ');
    }
    case 'FILE':
    case 'IMAGE': {
      const count = (value.mediaIds ?? []).length;
      return count === 0 ? null : `${String(count)} attachment${count === 1 ? '' : 's'}`;
    }
  }
}
