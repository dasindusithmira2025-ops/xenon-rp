import { SiteFooter } from '~/components/site/site-footer';
import { SiteHeader } from '~/components/site/site-header';
import { getSiteChrome } from '~/server/site';

/**
 * Public site shell.
 *
 * The header floats over the page rather than pushing it down, so a hero can
 * start at the top of the viewport. Pages that are not heroes add their own top
 * padding; there is no global spacer, because a global spacer is exactly what
 * makes a cinematic hero impossible.
 */
export default async function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const chrome = await getSiteChrome();

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        viewer={chrome.viewer}
        serverState={chrome.serverState}
        playerCount={chrome.playerCount}
        discordInvite={chrome.discordInvite}
      />

      {chrome.banner === null ? null : (
        <div
          role="status"
          className="fixed inset-x-0 top-(--header-height) z-[38] border-b border-warning/30 bg-warning/10 px-5 py-2 text-center text-xs text-warning"
        >
          {chrome.banner}
        </div>
      )}

      <main id="main" className="flex-1">
        {children}
      </main>

      <SiteFooter
        discordInvite={chrome.discordInvite}
        socials={chrome.socials}
        ruleVersion={chrome.ruleVersion}
      />
    </div>
  );
}
