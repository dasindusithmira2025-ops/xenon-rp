import { Eye, Pencil, Settings2 } from 'lucide-react';

import { Badge, Panel } from '@xenon/ui';

import type { AccessRowView } from './setup-console';

/**
 * Who can see, send and manage - per restricted area, per representative member.
 *
 * Public channels are omitted: the question operators actually ask is "can the
 * wrong person see staff, ops, a department or an organisation", and a table of
 * forty identical public rows buries the answer.
 */
export function AccessMatrix({
  rows,
  source,
}: {
  rows: readonly AccessRowView[];
  source: 'live' | 'blueprint';
}): React.ReactElement {
  const restricted = rows.filter((row) => row.visibility !== 'public');
  if (restricted.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        Generate a plan or run validation to see effective access.
      </p>
    );
  }
  const personas = restricted[0]?.access.map((entry) => entry.persona) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">
        {source === 'live'
          ? 'Computed from the live server with Discord’s permission algorithm.'
          : 'Computed from the blueprint; nothing has been provisioned yet.'}{' '}
        <Eye className="inline size-3" aria-hidden /> view ·{' '}
        <Pencil className="inline size-3" aria-hidden /> send ·{' '}
        <Settings2 className="inline size-3" aria-hidden /> manage
      </p>
      <Panel tone="flat" pad="none" className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className="sticky left-0 bg-surface px-3 py-2 font-medium text-ink-secondary">
                Area
              </th>
              {personas.map((persona) => (
                <th
                  key={persona}
                  className="px-2 py-2 font-medium whitespace-nowrap text-ink-muted"
                >
                  {persona}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {restricted.map((row) => (
              <tr key={row.key} className="border-b border-line last:border-0">
                <td className="sticky left-0 bg-surface px-3 py-2">
                  <p className="text-ink">{row.label}</p>
                  <Badge tone="neutral" className="mt-1">
                    {row.visibility}
                  </Badge>
                </td>
                {row.access.map((entry) => (
                  <td key={entry.persona} className="px-2 py-2 text-center">
                    {entry.view ? (
                      <span className="inline-flex items-center gap-0.5 text-xenon">
                        <Eye className="size-3" aria-label="can view" />
                        {entry.send ? <Pencil className="size-3" aria-label="can send" /> : null}
                        {entry.manage ? (
                          <Settings2 className="size-3 text-warning" aria-label="can manage" />
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-ink-muted" aria-label="no access">
                        —
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
