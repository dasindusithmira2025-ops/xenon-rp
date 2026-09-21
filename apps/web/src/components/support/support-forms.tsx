'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Button,
  Field,
  Input,
  Panel,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@xenon/ui';

import type { ActionResult } from '~/lib/action-result';

import {
  createAppealAction,
  createReportAction,
  createTicketAction,
} from '~/app/(site)/support/actions';

/**
 * Support intake.
 *
 * Three related but genuinely different things behind one set of tabs, because
 * players do not arrive knowing which one they need - and a ticket filed as an
 * appeal, or an accusation filed as a ticket, costs staff more time than the
 * tab costs to build.
 *
 * Each form keeps its own draft in component state only. Unlike an application,
 * these are minutes of typing rather than an hour, so server-side autosave
 * would be machinery for a problem that does not exist here.
 */

type Errors = Record<string, string[]>;

function useSubmit(
  action: (raw: unknown) => Promise<ActionResult<{ publicId: string }>>,
  successTitle: string,
): {
  errors: Errors;
  pending: boolean;
  submit: (payload: Record<string, unknown>, onDone: () => void) => void;
} {
  const router = useRouter();
  const toast = useToast();
  const [errors, setErrors] = React.useState<Errors>({});
  const [pending, startTransition] = React.useTransition();

  const submit = (payload: Record<string, unknown>, onDone: () => void): void => {
    setErrors({});
    startTransition(async () => {
      const result = await action(payload);

      if (result.ok) {
        toast.success(successTitle, `Reference ${result.data.publicId}`);
        onDone();
        router.refresh();
        return;
      }

      setErrors(result.fieldErrors ?? {});
      // Field errors are shown inline; anything else needs the toast, or the
      // user is left staring at a form that silently did nothing.
      if (result.fieldErrors === undefined) toast.error('Could not submit', result.message);
    });
  };

  return { errors, pending, submit };
}

export function SupportForms(): React.ReactElement {
  return (
    <Tabs defaultValue="ticket" className="flex flex-col gap-8">
      <TabsList>
        <TabsTrigger value="ticket">Support ticket</TabsTrigger>
        <TabsTrigger value="report">Report a player</TabsTrigger>
        <TabsTrigger value="appeal">Appeal a decision</TabsTrigger>
      </TabsList>

      <TabsContent value="ticket">
        <TicketForm />
      </TabsContent>
      <TabsContent value="report">
        <ReportForm />
      </TabsContent>
      <TabsContent value="appeal">
        <AppealForm />
      </TabsContent>
    </Tabs>
  );
}

function TicketForm(): React.ReactElement {
  const [category, setCategory] = React.useState('GENERAL');
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const { errors, pending, submit } = useSubmit(createTicketAction, 'Ticket opened');

  const reset = (): void => {
    setSubject('');
    setBody('');
  };

  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <form
        className="flex flex-col gap-6"
        action={() => {
          submit({ category, subject, body, mediaIds: [] }, reset);
        }}
      >
        <p className="text-sm leading-relaxed text-ink-secondary">
          For account problems, whitelist questions, technical issues and anything else that needs a
          person. You will get a reply in your portal and, if your DMs are open, on Discord.
        </p>

        <Field label="What is this about?" htmlFor="ticket-category" required>
          <Select
            id="ticket-category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
          >
            <option value="GENERAL">General question</option>
            <option value="ACCOUNT">My account</option>
            <option value="WHITELIST">Whitelist or application</option>
            <option value="TECHNICAL">Technical problem</option>
            <option value="OTHER">Something else</option>
          </Select>
        </Field>

        <Field
          label="Subject"
          htmlFor="ticket-subject"
          required
          error={errors.subject}
          meta={`${String(subject.length)} / 120`}
        >
          <Input
            id="ticket-subject"
            value={subject}
            maxLength={120}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
            placeholder="A short summary"
          />
        </Field>

        <Field
          label="Tell us what happened"
          htmlFor="ticket-body"
          required
          hint="Include anything that would help: times, character names, what you expected."
          error={errors.body}
          meta={`${String(body.length)} / 5000`}
        >
          <Textarea
            id="ticket-body"
            value={body}
            maxLength={5000}
            rows={8}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        </Field>

        <div className="flex justify-end">
          <Button type="submit" variant="accent" loading={pending}>
            Open ticket
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ReportForm(): React.ReactElement {
  const [kind, setKind] = React.useState('PLAYER');
  const [subjectLabel, setSubjectLabel] = React.useState('');
  const [summary, setSummary] = React.useState('');
  const [details, setDetails] = React.useState('');
  const [occurredAt, setOccurredAt] = React.useState('');
  const { errors, pending, submit } = useSubmit(createReportAction, 'Report filed');

  const reset = (): void => {
    setSubjectLabel('');
    setSummary('');
    setDetails('');
    setOccurredAt('');
  };

  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <form
        className="flex flex-col gap-6"
        action={() => {
          submit(
            {
              kind,
              subjectLabel: subjectLabel.length > 0 ? subjectLabel : undefined,
              summary,
              details,
              occurredAt: occurredAt.length > 0 ? occurredAt : undefined,
              mediaIds: [],
            },
            reset,
          );
        }}
      >
        <p className="text-sm leading-relaxed text-ink-secondary">
          Reports are read by staff only. A report about a staff member goes to a separate team -
          the person you are reporting will not see it.
        </p>

        <Field label="What kind of report?" htmlFor="report-kind" required>
          <Select
            id="report-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
            }}
          >
            <option value="PLAYER">A player broke the rules</option>
            <option value="STAFF">A staff member</option>
            <option value="BUG">A bug in the server or site</option>
          </Select>
        </Field>

        {kind === 'BUG' ? null : (
          <Field
            label="Who is this about?"
            htmlFor="report-subject"
            hint="A Xenon ID like XN-10082, a character name, or a Discord name. Leave blank if you do not know."
            error={errors.subjectLabel}
          >
            <Input
              id="report-subject"
              value={subjectLabel}
              maxLength={120}
              onChange={(event) => {
                setSubjectLabel(event.target.value);
              }}
            />
          </Field>
        )}

        <Field
          label="Summary"
          htmlFor="report-summary"
          required
          error={errors.summary}
          meta={`${String(summary.length)} / 140`}
        >
          <Input
            id="report-summary"
            value={summary}
            maxLength={140}
            onChange={(event) => {
              setSummary(event.target.value);
            }}
            placeholder="One line"
          />
        </Field>

        <Field
          label="What happened?"
          htmlFor="report-details"
          required
          hint="Be specific and factual. Timestamps and clip links help enormously."
          error={errors.details}
          meta={`${String(details.length)} / 8000`}
        >
          <Textarea
            id="report-details"
            value={details}
            maxLength={8000}
            rows={10}
            onChange={(event) => {
              setDetails(event.target.value);
            }}
          />
        </Field>

        <Field label="When did it happen?" htmlFor="report-when" error={errors.occurredAt}>
          <Input
            id="report-when"
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => {
              setOccurredAt(event.target.value);
            }}
          />
        </Field>

        <div className="flex justify-end">
          <Button type="submit" variant="accent" loading={pending}>
            File report
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function AppealForm(): React.ReactElement {
  const [kind, setKind] = React.useState('BAN');
  const [statement, setStatement] = React.useState('');
  const [sanctionRef, setSanctionRef] = React.useState('');
  const { errors, pending, submit } = useSubmit(createAppealAction, 'Appeal submitted');

  const reset = (): void => {
    setStatement('');
    setSanctionRef('');
  };

  return (
    <Panel tone="raised" pad="lg" edgeLight>
      <form
        className="flex flex-col gap-6"
        action={() => {
          submit(
            {
              kind,
              statement,
              sanctionRef: sanctionRef.length > 0 ? sanctionRef : undefined,
              mediaIds: [],
            },
            reset,
          );
        }}
      >
        <p className="text-sm leading-relaxed text-ink-secondary">
          One appeal at a time. Tell us what happened from your side and why you think the decision
          should change. Appeals are decided by someone other than whoever made the original call
          wherever possible.
        </p>

        <Field label="What are you appealing?" htmlFor="appeal-kind" required>
          <Select
            id="appeal-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
            }}
          >
            <option value="BAN">A ban or suspension</option>
            <option value="WHITELIST_REVOCATION">Losing whitelist access</option>
            <option value="DEPARTMENT_REMOVAL">Removal from a department</option>
            <option value="OTHER">Something else</option>
          </Select>
        </Field>

        <Field
          label="Reference"
          htmlFor="appeal-ref"
          hint="If staff gave you a reference or a ticket number, put it here."
          error={errors.sanctionRef}
        >
          <Input
            id="appeal-ref"
            value={sanctionRef}
            maxLength={120}
            onChange={(event) => {
              setSanctionRef(event.target.value);
            }}
          />
        </Field>

        <Field
          label="Your statement"
          htmlFor="appeal-statement"
          required
          hint="At least a few sentences. What happened, what you would do differently, and why the decision should change."
          error={errors.statement}
          meta={`${String(statement.length)} / 8000`}
        >
          <Textarea
            id="appeal-statement"
            value={statement}
            maxLength={8000}
            rows={12}
            onChange={(event) => {
              setStatement(event.target.value);
            }}
          />
        </Field>

        <div className="flex justify-end">
          <Button type="submit" variant="accent" loading={pending}>
            Submit appeal
          </Button>
        </div>
      </form>
    </Panel>
  );
}
