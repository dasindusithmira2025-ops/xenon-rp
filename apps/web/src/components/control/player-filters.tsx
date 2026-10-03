'use client';

import { Search, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button, Input, Select } from '@xenon/ui';
import { LoadingRail } from '@xenon/ui/motion';

import { useFilterNavigation } from './use-filter-navigation';

/** Player directory filters. URL-backed, for the same reasons as the queue. */
export function PlayerFilters(): React.ReactElement {
  const params = useSearchParams();
  const { navigate, pending } = useFilterNavigation();
  const [query, setQuery] = React.useState(params.get('q') ?? '');

  const update = (key: string, value: string | null): void => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value.length === 0) next.delete(key);
    else next.set(key, value);
    next.delete('page');
    navigate(next);
  };

  const active = ['q', 'whitelist', 'status'].some((key) => params.get(key) !== null);

  return (
    <div className="relative flex flex-wrap items-center gap-2 pb-1">
      {/* Shown only while a request is genuinely outstanding: the rows stay on
          screen and this reports that they are being refreshed. */}
      {pending ? (
        <LoadingRail className="absolute inset-x-0 bottom-0" label="Updating the directory" />
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
          placeholder="XN-10082, name, Discord username or ID"
          aria-label="Search players"
          className="h-9 pl-9 text-xs"
        />
      </form>

      <Select
        value={params.get('whitelist') ?? ''}
        aria-label="Whitelist state"
        className="h-9 w-auto min-w-36 text-xs"
        onChange={(event) => {
          update('whitelist', event.target.value);
        }}
      >
        <option value="">Any whitelist</option>
        <option value="APPROVED">Approved</option>
        <option value="NONE">None</option>
        <option value="SUSPENDED">Suspended</option>
        <option value="REVOKED">Revoked</option>
      </Select>

      <Select
        value={params.get('status') ?? ''}
        aria-label="Account status"
        className="h-9 w-auto min-w-36 text-xs"
        onChange={(event) => {
          update('status', event.target.value);
        }}
      >
        <option value="">Any status</option>
        <option value="ACTIVE">Active</option>
        <option value="SUSPENDED">Suspended</option>
        <option value="BANNED">Banned</option>
      </Select>

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
