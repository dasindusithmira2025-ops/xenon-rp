import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function isSafeRuleHref(href: string): boolean {
  const value = href.trim();
  if (
    value.length === 0 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return false;
  }
  if (value.startsWith('//')) return true;

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

const components: Components = {
  h1: ({ children }) => <h2 className="mt-7 text-lg font-semibold text-ink">{children}</h2>,
  h2: ({ children }) => <h2 className="mt-7 text-lg font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-6 text-base font-semibold text-ink">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-5 font-semibold text-ink">{children}</h4>,
  p: ({ children }) => <p className="mt-4 max-w-4xl leading-8 text-ink-secondary">{children}</p>,
  ul: ({ children }) => (
    <ul className="mt-4 max-w-4xl list-disc space-y-2 ps-7 leading-8 text-ink-secondary marker:text-xenon">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-4 max-w-4xl list-decimal space-y-2 ps-7 leading-8 text-ink-secondary marker:text-xenon">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="ps-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mt-5 border-s-2 border-xenon/60 bg-elevated/50 px-4 py-1 text-ink-secondary">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    if (href === undefined || !isSafeRuleHref(href)) return <>{children}</>;
    const external = /^(https?:)?\/\//i.test(href);
    return (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="text-xenon underline decoration-xenon/40 underline-offset-4 hover:decoration-xenon"
      >
        {children}
      </a>
    );
  },
  img: () => null,
  table: ({ children }) => (
    <div className="mt-5 max-w-full overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-left text-sm text-ink-secondary">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line-strong bg-elevated px-3 py-2 font-semibold text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-line px-3 py-2 align-top">{children}</td>,
  pre: ({ children }) => (
    <pre className="mt-5 max-w-full overflow-x-auto rounded-md border border-line bg-elevated p-4 text-sm">
      {children}
    </pre>
  ),
};

/** Server-rendered rulebook Markdown; raw HTML is intentionally never enabled. */
export function RuleMarkdownContent({ markdown }: { readonly markdown: string }) {
  return (
    <div className="x-rule-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
