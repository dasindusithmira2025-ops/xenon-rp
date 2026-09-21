import { NextResponse } from 'next/server';

import { toSafeMessage } from '@xenon/core';
import { prisma } from '@xenon/database';
import { enforceRateLimit } from '@xenon/jobs';
import { IMAGE_MIME_TYPES, storeUpload } from '@xenon/storage';

import { currentActor } from '~/server/context';

/**
 * Media upload.
 *
 * The bytes are validated before anything is stored: size, then the declared
 * type against an allow-list, then the declared type against the file's actual
 * magic number. The last check is the one that matters - `Content-Type` is
 * attacker-controlled, so an HTML payload can arrive labelled `image/png`.
 *
 * Visibility is decided here from the purpose, not accepted from the client.
 * A caller must not be able to publish an application attachment to the public
 * gallery by changing one field.
 */

const PURPOSES = {
  gallery: { visibility: 'PUBLIC', permission: 'content.edit' },
  department: { visibility: 'PUBLIC', permission: 'departments.manage' },
  article: { visibility: 'PUBLIC', permission: 'content.edit' },
  application_answer: { visibility: 'PRIVATE', permission: null },
  ticket: { visibility: 'PRIVATE', permission: null },
  report: { visibility: 'STAFF_ONLY', permission: null },
} as const;

type Purpose = keyof typeof PURPOSES;

export async function POST(request: Request): Promise<NextResponse> {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json(
      { ok: false, message: 'Cross-origin request refused' },
      { status: 403 },
    );
  }

  const actor = await currentActor();
  if (actor.userId === null) {
    return NextResponse.json({ ok: false, message: 'Sign in to continue.' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, message: 'Malformed upload.' }, { status: 400 });
  }

  const file = form.get('file');
  const rawPurpose = form.get('purpose');

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, message: 'No file supplied.' }, { status: 400 });
  }
  if (typeof rawPurpose !== 'string' || !(rawPurpose in PURPOSES)) {
    return NextResponse.json({ ok: false, message: 'Unknown upload purpose.' }, { status: 400 });
  }

  const purpose = rawPurpose as Purpose;
  const rule = PURPOSES[purpose];

  if (rule.permission !== null && !actor.permissions.has(rule.permission)) {
    return NextResponse.json({ ok: false, message: 'Not allowed.' }, { status: 403 });
  }

  await enforceRateLimit('upload', actor.userId);

  try {
    const asset = await storeUpload(prisma, {
      body: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      originalName: file.name,
      purpose,
      ownerId: actor.userId,
      visibility: rule.visibility,
      allowedMimeTypes: IMAGE_MIME_TYPES,
    });

    return NextResponse.json({ ok: true, mediaId: asset.id, sizeBytes: asset.sizeBytes });
  } catch (error) {
    const status =
      error !== null && typeof error === 'object' && 'httpStatus' in error
        ? Number(error.httpStatus)
        : 500;

    if (status >= 500) console.error('[media] upload failed', error);

    return NextResponse.json(
      { ok: false, message: toSafeMessage(error) },
      { status: Number.isFinite(status) ? status : 500 },
    );
  }
}
