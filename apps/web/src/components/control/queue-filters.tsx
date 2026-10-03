'use client';

import { Search, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button, Input, Select } from '@xenon/ui';
import { LoadingRail } from '@xenon/ui/motion';

import { useFilterNavigation } from './use-filter-navigation';

/**
 * Queue filters.
 *
 * State lives in the URL, not in component state. That makes a filtered queue
 * shareable ("look at XN-WL applications waiting over a week"), survivable
 * across a refresh, and back-button correct - none of which a `useState` filter
 * gives you.
 *
 * The cost of putting it in the URL is that every filter change is a
 * navigation, and a navigation would otherwise replace the queue with a
 * skeleton. `useFilterNavigation` holds the rows on screen and reports the wait
 * as a rail instead.
 */
export function QueueFilters({
  templates,
}: {
  templates: readonly { id: string; name: string }[];
}): React.ReactElement {
  const params = useSearchParams();
  const { navigate, pending } = useFilterNavigation();

  const [query, setQuery] = React.useState(params.get('q') ?? '');

  const update = (key: string, value: string | null): void => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value.length === 0) next.delete(key);
    else next.set(key, value);
    // Any filter change invalidates the page cursor.
    next.delete('page');
    navigate(next);
  };

  const active =
    params.get('status') !== null ||
    params.get('template') !== null ||
    params.get('q') !== null ||
    params.get('mine') !== null;

  return (
    <div className="relative flex flex-wrap items-center gap-2 pb-1">
      {/* Only while a request is actually outstanding. A rail that is always
          there is furniture, and furniture is ignored. */}
      {pending ? (
        <LoadingRail className="absolute inset-x-0 bottom-0" label="Updating the queue" />
      ) : null}
      <form
        className="relative min-w-56 flex-1"
        action={() => {
          update('q', query);
        }}
      >
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="XN-WL-1842, name, or Xenon ID"
          aria-label="Search the queue"
          className="h-9 pl-9 text-xs"
        />
      </form>

      <Select
        value={params.get('status') ?? ''}
        aria-label="Status"
        className="h-9 w-auto min-w-40 text-xs"
        onChange={(event) => {
          update('status', event.target.value);
        }}
      >
        <option value="">Waiting on staff</option>
        <option value="SUBMITTED">Submitted</option>
        <option value="RESUBMITTED">Resubmitted</option>
        <option value="UNDER_REVIEW">Under review</option>
        <option value="INTERVIEW_REQUIRED">Interview required</option>
        <option value="INTERVIEW_SCHEDULED">Interview scheduled</option>
        <option value="CHANGES_REQUESTED">Changes requested</option>
        <option value="APPROVED">Approved</option>
        <option value="REJECTED">Rejected</option>
      </Select>

      <Select
        value={params.get('template') ?? ''}
        aria-label="Application type"
        className="h-9 w-auto min-w-40 text-xs"
        onChange={(event) => {
          update('template', event.target.value);
        }}
      >
        <option value="">All types</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </Select>

      <Button
        variant={params.get('mine') === '1' ? 'accent' : 'outline'}
        size="sm"
        onClick={() => {
          update('mine', params.get('mine') === '1' ? null : '1');
        }}
      >
        Assigned to me
      </Button>

      {active ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQuery('');
            navigate(null);
          }}
        >
          <X /> Clear
        </Button>
      ) : null}
    </div>
  );
}
