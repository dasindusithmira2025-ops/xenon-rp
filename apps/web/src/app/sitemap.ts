import { publicEnv } from '@xenon/config/public';
import { prisma } from '@xenon/database';
import { publishedArticles, publishedDepartments } from '@xenon/domain';

import type { MetadataRoute } from 'next';

/**
 * Sitemap.
 *
 * Only public, indexable routes. The portal, the control centre, the sign-in
 * page and every API route are deliberately absent: they are either private,
 * per-user, or both, and listing them would invite crawlers to hammer
 * authenticated endpoints.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = publicEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/city`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/departments`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/rules`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/applications`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/news`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${base}/gallery`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${base}/community`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/status`, changeFrequency: 'hourly', priority: 0.5 },
    { url: `${base}/support`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/terms`, changeFrequency: 'yearly', priority: 0.2 },
  ];

  const [departments, articles, templates] = await Promise.all([
    publishedDepartments(prisma),
    publishedArticles(prisma, 200),
    prisma.applicationTemplate.findMany({
      where: { status: { in: ['OPEN', 'CLOSED'] } },
      select: { slug: true, updatedAt: true },
    }),
  ]);

  return [
    ...staticRoutes,
    ...departments.map((department) => ({
      url: `${base}/departments/${department.slug}`,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    ...articles.map((article) => ({
      url: `${base}/news/${article.slug}`,
      lastModified: article.publishedAt === null ? undefined : new Date(article.publishedAt),
      changeFrequency: 'yearly' as const,
      priority: 0.6,
    })),
    ...templates.map((template) => ({
      url: `${base}/applications/${template.slug}`,
      lastModified: template.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
