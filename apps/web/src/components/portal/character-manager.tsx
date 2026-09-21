'use client';

import { Plus, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  Panel,
  Textarea,
  useToast,
} from '@xenon/ui';

import {
  createCharacterAction,
  retireCharacterAction,
  updateCharacterAction,
} from '~/app/(portal)/portal/actions';
import { optionalText, text } from '~/lib/form';

/**
 * Characters.
 *
 * Only the fields the schema models. Cash, inventory and licences belong to the
 * game server and would be stale the moment they were copied here, so the
 * portal does not pretend to own them.
 *
 * Retiring rather than deleting: submissions, tickets and audit entries all
 * reference a character, and a hole in that history is worse than a row marked
 * retired.
 */

export interface CharacterRecord {
  readonly id: string;
  readonly publicId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly alias: string | null;
  readonly occupation: string | null;
  readonly backstory: string | null;
  readonly dateOfBirth: string | null;
  readonly status: string;
  readonly createdAt: string;
}

/**
 * Typed as an open record on purpose: `status` arrives as a plain string from
 * the server component, so the lookup genuinely can miss and the fallback is
 * not dead code.
 */
const statusTone: Record<string, 'success' | 'neutral' | 'danger'> = {
  ACTIVE: 'success',
  DRAFT: 'neutral',
  RETIRED: 'neutral',
  DECEASED: 'danger',
  REJECTED: 'danger',
};

export function CharacterManager({
  characters,
  limit,
}: {
  characters: readonly CharacterRecord[];
  limit: number;
}): React.ReactElement {
  const [editing, setEditing] = React.useState<CharacterRecord | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [retiring, setRetiring] = React.useState<CharacterRecord | null>(null);
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();

  const active = characters.filter(
    (character) => character.status === 'ACTIVE' || character.status === 'DRAFT',
  );
  const atLimit = active.length >= limit;

  const retire = (): void => {
    if (retiring === null) return;
    startTransition(async () => {
      const result = await retireCharacterAction(retiring.id);
      if (result.ok) {
        toast.success('Character retired', `${retiring.firstName} is no longer active.`);
        setRetiring(null);
        router.refresh();
        return;
      }
      toast.error('Could not retire', result.message);
    });
  };

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-ink-muted">
            {active.length} of {limit} active
          </p>
          <Button
            variant="accent"
            disabled={atLimit}
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus /> New character
          </Button>
        </div>

        {characters.length === 0 ? (
          <EmptyState
            icon={<UserRound className="size-6" />}
            title="No characters yet"
            description="Create the person you intend to play. You can change their details later."
            action={
              <Button
                variant="accent"
                onClick={() => {
                  setCreating(true);
                }}
              >
                Create a character
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {characters.map((character) => (
              <Panel key={character.id} tone="flat" pad="lg" className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display truncate text-lg font-bold text-ink">
                      {character.firstName} {character.lastName}
                    </p>
                    {character.alias === null ? null : (
                      <p className="text-sm text-ink-muted">&ldquo;{character.alias}&rdquo;</p>
                    )}
                  </div>
                  <Badge tone={statusTone[character.status] ?? 'neutral'}>
                    {character.status.toLowerCase()}
                  </Badge>
                </div>

                <dl className="flex flex-col gap-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">ID</dt>
                    <dd className="font-mono text-ink-secondary">{character.publicId}</dd>
                  </div>
                  {character.occupation === null ? null : (
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-muted">Occupation</dt>
                      <dd className="text-ink-secondary">{character.occupation}</dd>
                    </div>
                  )}
                </dl>

                {character.backstory === null ? null : (
                  <p className="line-clamp-3 text-sm leading-relaxed text-ink-muted">
                    {character.backstory}
                  </p>
                )}

                {character.status === 'ACTIVE' || character.status === 'DRAFT' ? (
                  <div className="mt-auto flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(character);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRetiring(character);
                      }}
                    >
                      Retire
                    </Button>
                  </div>
                ) : null}
              </Panel>
            ))}
          </div>
        )}
      </div>

      <CharacterDialog
        open={creating || editing !== null}
        character={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />

      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => {
          if (!open) setRetiring(null);
        }}
        title="Retire this character?"
        description={
          retiring === null
            ? ''
            : `${retiring.firstName} ${retiring.lastName} will be marked retired. Their history stays on your account, and you free up a slot.`
        }
        confirmLabel="Retire"
        tone="danger"
        loading={pending}
        onConfirm={retire}
      />
    </>
  );
}

function CharacterDialog({
  open,
  character,
  onOpenChange,
}: {
  open: boolean;
  character: CharacterRecord | null;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = React.useTransition();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});

  // Keyed on the character so opening a different one remounts with its values
  // rather than carrying the previous one's state across.
  const formKey = character?.id ?? 'new';

  const submit = (form: FormData): void => {
    const payload = {
      firstName: text(form, 'firstName'),
      lastName: text(form, 'lastName'),
      alias: text(form, 'alias'),
      occupation: text(form, 'occupation'),
      backstory: text(form, 'backstory'),
      dateOfBirth: optionalText(form, 'dateOfBirth'),
    };

    setErrors({});
    startTransition(async () => {
      const result =
        character === null
          ? await createCharacterAction(payload)
          : await updateCharacterAction(character.id, payload);

      if (result.ok) {
        toast.success(character === null ? 'Character created' : 'Character updated');
        onOpenChange(false);
        router.refresh();
        return;
      }

      setErrors(result.fieldErrors ?? {});
      if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title={character === null ? 'New character' : 'Edit character'}
          description="This is the person the city meets. You can change it later."
        />

        <form key={formKey} action={submit} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="firstName" required error={errors.firstName}>
              <Input name="firstName" defaultValue={character?.firstName ?? ''} maxLength={32} />
            </Field>
            <Field label="Last name" htmlFor="lastName" required error={errors.lastName}>
              <Input name="lastName" defaultValue={character?.lastName ?? ''} maxLength={32} />
            </Field>
          </div>

          <Field
            label="Alias"
            htmlFor="alias"
            hint="What the city calls them, if anything."
            error={errors.alias}
          >
            <Input name="alias" defaultValue={character?.alias ?? ''} maxLength={32} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Occupation" htmlFor="occupation" error={errors.occupation}>
              <Input name="occupation" defaultValue={character?.occupation ?? ''} maxLength={64} />
            </Field>
            <Field label="Date of birth" htmlFor="dateOfBirth" error={errors.dateOfBirth}>
              <Input name="dateOfBirth" type="date" defaultValue={character?.dateOfBirth ?? ''} />
            </Field>
          </div>

          <Field
            label="Backstory"
            htmlFor="backstory"
            hint="Where they came from and what they want. Useful for applications."
            error={errors.backstory}
          >
            <Textarea
              name="backstory"
              defaultValue={character?.backstory ?? ''}
              rows={6}
              maxLength={4000}
            />
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={pending}>
              {character === null ? 'Create' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
