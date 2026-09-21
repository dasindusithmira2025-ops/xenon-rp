'use client';

import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Data table.
 *
 * Built for the control centre, where density matters and a row is something
 * staff scan a hundred of. Two decisions carry most of the weight:
 *
 *  - The table always sits inside its own horizontal scroll container, so a
 *    wide table never makes the whole page scroll sideways on a laptop.
 *  - The header is sticky, because a queue with fifty rows is useless if you
 *    have to scroll back up to remember which column is which.
 */

export function TableShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'relative w-full overflow-x-auto rounded-lg border border-line bg-surface',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <table className={cn('w-full border-collapse text-sm', className)}>{children}</table>;
}

export function THead({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <thead className="sticky top-0 z-10 bg-elevated/95 backdrop-blur-sm">
      <tr className="border-b border-line-strong">{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  className,
  align = 'left',
  width,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
}): React.ReactElement {
  return (
    <th
      scope="col"
      style={width === undefined ? undefined : { width }}
      className={cn(
        'x-eyebrow px-3 py-2.5 font-medium whitespace-nowrap',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { children: React.ReactNode }): React.ReactElement {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
  selected = false,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}): React.ReactElement {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'transition-colors duration-(--duration-fast)',
        onClick === undefined ? '' : 'cursor-pointer',
        selected ? 'bg-xenon-deep/15' : 'hover:bg-elevated',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TD({
  children,
  className,
  align = 'left',
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  colSpan?: number;
}): React.ReactElement {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'px-3 py-2.5 align-middle text-ink-secondary',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Simple offset pagination. Pages are 1-indexed, matching the URL. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}): React.ReactElement | null {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex items-center justify-between gap-4 py-3 text-sm', className)}
    >
      <p className="x-tabular text-xs text-ink-muted">
        {first}–{last} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => {
            onPageChange(page - 1);
          }}
          className="rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-elevated disabled:opacity-40"
        >
          Previous
        </button>
        <span className="x-tabular px-2 text-xs text-ink-muted">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => {
            onPageChange(page + 1);
          }}
          className="rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-elevated disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
