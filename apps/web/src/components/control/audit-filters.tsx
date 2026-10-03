'use client';

import { Search, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button, Input, Select } from '@xenon/ui';
import { LoadingRail } from '@xenon/ui/motion';

import { useFilterNavigation } from './use-filter-navigation';

/**
 * Audit filters.
 *
 * The entity type list is the set of things the services actually write audit
 * entries for. It is a short, closed list, so a select beats a free-text field
 * that only matches when you spell `application_submission` correctly.
 */
const entityTypes = [
  'application_submission',
  'application_template',
  'application_question',
  'user',
  'whitelist',
  'role',
  'rule',
  'ruleset',
  'department',
  'ticket',
  'report',
  'appeal',
  'article',
  'gallery_item',
  'server',
  'setting',
  'feature_flag',
] as const;

export function AuditFilters(): React.ReactElement {
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

  const active = ['q', 'entityType', 'action', 'entityId', 'from', 'to'].some(
    (key) => params.get(key) !== null,
  );

  return (
    <div className="relative flex flex-wrap items-center gap-2 pb-1">
      {/* Shown only while a request is genuinely outstanding: the rows stay on
          screen and this reports that they are being refreshed. */}
      {pending ? (
        <LoadingRail className="absolute inset-x-0 bottom-0" label="Updating the audit log" />
      ) : null}
      <form
        className="relative min-w-52 flex-1"
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
          placeholder="XN-WL-1842, an actor name, or an action"
          aria-label="Search the audit log"
          className="h-9 pl-9 text-xs"
        />
      </form>

      <Select
        value={params.get('entityType') ?? ''}
        aria-label="Entity type"
        className="h-9 w-auto min-w-44 text-xs"
        onChange={(event) => {
          update('entityType', event.target.value);
        }}
      >
        <option value="">Any entity</option>
        {entityTypes.map((type) => (
          <option key={type} value={type}>
            {type.replace(/_/g, ' ')}
          </option>
        ))}
      </Select>

      <Input
        type="date"
        value={params.get('from') ?? ''}
        aria-label="From date"
        className="h-9 w-auto text-xs"
        onChange={(event) => {
          update('from', event.target.value);
        }}
      />
      <Input
        type="date"
        value={params.get('to') ?? ''}
        aria-label="To date"
        className="h-9 w-auto text-xs"
        onChange={(event) => {
          update('to', event.target.value);
        }}
      />

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
