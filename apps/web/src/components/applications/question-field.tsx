'use client';

import * as React from 'react';

import { Choice, Field, Input, Select, Textarea } from '@xenon/ui';
import type { AnswerValue, QuestionDefinition } from '@xenon/validation';

/**
 * One question, rendered by type.
 *
 * Every branch produces the same `AnswerValue` shape, so the autosave payload
 * and the server-side validator do not have to know which control the player
 * saw. Adding a question type is a case here and a case in the validator, and
 * nothing else in the application changes.
 */

export interface QuestionFieldProps {
  readonly question: QuestionDefinition & {
    helpText: string | null;
    placeholder: string | null;
  };
  readonly value: AnswerValue | undefined;
  readonly errors: readonly string[] | undefined;
  readonly disabled: boolean;
  readonly characters: readonly { id: string; label: string }[];
  readonly onChange: (value: AnswerValue) => void;
}

export function QuestionField({
  question,
  value,
  errors,
  disabled,
  characters,
  onChange,
}: QuestionFieldProps): React.ReactElement {
  const id = `q-${question.key}`;
  const chosen = value?.choiceValues ?? [];

  const toggleChoice = (optionValue: string, multiple: boolean): void => {
    if (!multiple) {
      onChange({ choiceValues: [optionValue] });
      return;
    }
    onChange({
      choiceValues: chosen.includes(optionValue)
        ? chosen.filter((entry) => entry !== optionValue)
        : [...chosen, optionValue],
    });
  };

  switch (question.type) {
    case 'SHORT_TEXT':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
          meta={
            question.maxLength === null
              ? undefined
              : `${String((value?.textValue ?? '').length)} / ${String(question.maxLength)}`
          }
        >
          <Input
            value={value?.textValue ?? ''}
            placeholder={question.placeholder ?? undefined}
            maxLength={question.maxLength ?? undefined}
            disabled={disabled}
            onChange={(event) => {
              onChange({ textValue: event.target.value });
            }}
          />
        </Field>
      );

    case 'LONG_TEXT':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
          meta={
            // A minimum is shown as progress rather than as a violation: a
            // counter that reads "40 / 400" while you are still typing your
            // first sentence is discouraging, not helpful.
            question.minLength !== null && (value?.textValue ?? '').length < question.minLength
              ? `${String((value?.textValue ?? '').length)} / ${String(question.minLength)} minimum`
              : question.maxLength === null
                ? `${String((value?.textValue ?? '').length)} characters`
                : `${String((value?.textValue ?? '').length)} / ${String(question.maxLength)}`
          }
        >
          <Textarea
            value={value?.textValue ?? ''}
            placeholder={question.placeholder ?? undefined}
            maxLength={question.maxLength ?? undefined}
            disabled={disabled}
            rows={8}
            autoGrow
            onChange={(event) => {
              onChange({ textValue: event.target.value });
            }}
          />
        </Field>
      );

    case 'NUMBER':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
        >
          <Input
            type="number"
            inputMode="numeric"
            value={value?.numberValue ?? ''}
            min={question.minValue ?? undefined}
            max={question.maxValue ?? undefined}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              onChange({ numberValue: next === '' ? null : Number(next) });
            }}
          />
        </Field>
      );

    case 'DATE':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
        >
          <Input
            type="date"
            value={typeof value?.dateValue === 'string' ? value.dateValue : ''}
            disabled={disabled}
            onChange={(event) => {
              onChange({ dateValue: event.target.value });
            }}
          />
        </Field>
      );

    case 'SELECT':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
        >
          <Select
            value={chosen[0] ?? ''}
            disabled={disabled}
            onChange={(event) => {
              onChange({ choiceValues: event.target.value === '' ? [] : [event.target.value] });
            }}
          >
            <option value="">Choose…</option>
            {question.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      );

    case 'CHARACTER_SELECT':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? 'Pick one of your characters.'}
          error={errors}
        >
          <Select
            value={value?.textValue ?? ''}
            disabled={disabled || characters.length === 0}
            onChange={(event) => {
              onChange({ textValue: event.target.value });
            }}
          >
            <option value="">
              {characters.length === 0 ? 'You have no characters yet' : 'Choose a character…'}
            </option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.label}
              </option>
            ))}
          </Select>
        </Field>
      );

    case 'RADIO':
    case 'MULTI_SELECT':
    case 'CHECKBOX': {
      const multiple = question.type !== 'RADIO';
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={
            question.helpText ??
            (multiple && question.maxLength !== null
              ? `Choose up to ${String(question.maxLength)}.`
              : undefined)
          }
          error={errors}
        >
          <div role={multiple ? 'group' : 'radiogroup'} className="flex flex-col gap-2">
            {question.options.map((option) => (
              <Choice
                key={option.value}
                type={multiple ? 'checkbox' : 'radio'}
                name={id}
                label={option.label}
                checked={chosen.includes(option.value)}
                disabled={
                  disabled ||
                  // Enforced visually as well as in validation, so the limit is
                  // discovered while choosing rather than on submit.
                  (multiple &&
                    question.maxLength !== null &&
                    chosen.length >= question.maxLength &&
                    !chosen.includes(option.value))
                }
                onChange={() => {
                  toggleChoice(option.value, multiple);
                }}
              />
            ))}
          </div>
        </Field>
      );
    }

    case 'BOOLEAN':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
        >
          <div role="radiogroup" className="flex flex-col gap-2 sm:flex-row">
            <Choice
              type="radio"
              name={id}
              label="Yes"
              className="flex-1"
              checked={value?.booleanValue === true}
              disabled={disabled}
              onChange={() => {
                onChange({ booleanValue: true });
              }}
            />
            <Choice
              type="radio"
              name={id}
              label="No"
              className="flex-1"
              checked={value?.booleanValue === false}
              disabled={disabled}
              onChange={() => {
                onChange({ booleanValue: false });
              }}
            />
          </div>
        </Field>
      );

    case 'ACKNOWLEDGEMENT':
      return (
        <Field htmlFor={id} error={errors}>
          <Choice
            type="checkbox"
            label={question.label}
            hint={question.helpText ?? undefined}
            checked={value?.booleanValue === true}
            disabled={disabled}
            onChange={(event) => {
              onChange({ booleanValue: event.target.checked });
            }}
          />
        </Field>
      );

    case 'FILE':
    case 'IMAGE':
      return (
        <Field
          label={question.label}
          htmlFor={id}
          required={question.required}
          hint={question.helpText ?? undefined}
          error={errors}
        >
          {/*
            Attachments are uploaded through the media endpoint, which validates
            type and size server-side. Until an operator configures storage the
            field explains itself rather than offering a control that cannot
            work.
          */}
          <div className="rounded-md border border-dashed border-line-strong p-5 text-center">
            <p className="text-sm text-ink-secondary">
              {(value?.mediaIds ?? []).length > 0
                ? `${String((value?.mediaIds ?? []).length)} file(s) attached`
                : 'Attachments are added from your portal once media storage is configured.'}
            </p>
            <p className="mt-1.5 text-xs text-ink-muted">
              Paste a link in an earlier answer if you need to share a clip now.
            </p>
          </div>
        </Field>
      );
  }
}
