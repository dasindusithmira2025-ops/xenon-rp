import { Archivo, Geist, Geist_Mono } from 'next/font/google';

import { brand, siteMeta } from '@xenon/config';
import { publicEnv } from '@xenon/config/public';
import { ToastProvider, TooltipProvider } from '@xenon/ui';

import './globals.css';

import type { Metadata, Viewport } from 'next';

/**
 * Typography.
 *
 * Self-hosted at build time by `next/font`, so there is no third-party font
 * request on first paint, no layout shift from a swap, and nothing for the CSP
 * to allow. Three faces and no more: a display grotesk with real weight range
 * for the editorial headings, a neutral text face for everything that has to be
 * read, and a mono for identifiers and eyebrows.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['600', '700', '800', '900'],
  variable: '--font-archivo',
  display: 'swap',
});

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_SITE_URL),
  title: {
    default: siteMeta.title,
    // Page titles read "Rules | XenonRP" without every page repeating the suffix.
    template: `%s | ${brand.name}`,
  },
  description: siteMeta.description,
  applicationName: brand.name,
  keywords: ['FiveM', 'roleplay', 'Sri Lanka', 'GTA V', 'XenonRP', 'whitelist'],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: brand.name,
    title: siteMeta.title,
    description: siteMeta.description,
    locale: siteMeta.locale,
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: siteMeta.title,
    description: siteMeta.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: brand.palette.void,
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  // Never lock zoom: pinch-to-zoom is an accessibility feature, not a polish
  // problem to be designed around.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en" className={`${archivo.variable} ${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh bg-void text-ink antialiased">
        <a
          href="#main"
          className="sr-only rounded-md focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[90] focus:bg-xenon focus:px-4 focus:py-2 focus:font-semibold focus:text-ink-inverse"
        >
          Skip to content
        </a>
        <TooltipProvider delayDuration={250}>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
