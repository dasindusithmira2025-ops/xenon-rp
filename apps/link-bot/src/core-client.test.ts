import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { verifyServiceRequest } from '@xenon/contracts';
import { silentLogger } from '@xenon/logger';

import { CORE_UNAVAILABLE_MESSAGE, createCoreClient } from './core-client';

const SECRET = 'c'.repeat(40);
const ACTOR = '300000000000000003';

type FetchArgs = [url: string, init?: RequestInit];

function client(fetchImpl: (...args: FetchArgs) => Promise<Response>) {
  return createCoreClient({
    baseUrl: 'http://core.test:3300/',
    secret: SECRET,
    logger: silentLogger,
    fetch: fetchImpl as typeof fetch,
  });
}

function respond(status: number, body: unknown) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('core client', () => {
  const STATUS = {
    hasAccount: true,
    linked: true,
    cfxUsername: 'ravi_rp',
    linkedAt: '2026-10-10T12:10:00.000Z',
    verifiedOnWebsite: true,
  };

  it('signs each call as service link for the exact operation path', async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      const verification = verifyServiceRequest(
        SECRET,
        { service: 'link', method: 'POST', path },
        init?.body as string,
        (name) => headers.get(name),
      );
      expect(path).toBe('/internal/v1/link.status');
      expect(verification.ok).toBe(true);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            data: STATUS,
          }),
        ),
      );
    });

    const result = await client(fetchImpl)('link.status', { actorDiscordId: ACTOR });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: STATUS });
  });

  it('passes Core error envelopes through unchanged', async () => {
    const error = { code: 'FORBIDDEN', message: 'You cannot do that.' } as const;
    const result = await client(respond(403, { ok: false, error }))('applications.queue', {
      actorDiscordId: ACTOR,
    });
    expect(result).toEqual({ ok: false, error });
  });

  it('maps network failures and timeouts to the INTEGRATION message', async () => {
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    expect(await client(offline)('status.board', {})).toEqual({
      ok: false,
      error: { code: 'INTEGRATION', message: CORE_UNAVAILABLE_MESSAGE },
    });

    // Never answers; only the client's own timeout ends the call.
    const hanging = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.signal) await once(init.signal, 'abort');
      throw new Error('aborted');
    };
    const timed = await client(hanging)('status.board', {}, { timeoutMs: 20 });
    expect(timed).toEqual({
      ok: false,
      error: { code: 'INTEGRATION', message: CORE_UNAVAILABLE_MESSAGE },
    });
  });

  it('rejects responses that do not match the operation contract', async () => {
    const result = await client(respond(200, { ok: true, data: { linked: 1 } }))('link.status', {
      actorDiscordId: ACTOR,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });

  it('treats a non-JSON response as unavailable', async () => {
    const html = () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await client(html)('status.board', {})).toEqual({
      ok: false,
      error: { code: 'INTEGRATION', message: CORE_UNAVAILABLE_MESSAGE },
    });
  });

  it('aborts on an external signal without logging an outage', async () => {
    const warn = vi.fn();
    const controller = new AbortController();
    const abortable = createCoreClient({
      baseUrl: 'http://core.test:3300',
      secret: SECRET,
      logger: { ...silentLogger, warn },
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
        })) as typeof fetch,
    });

    const pending = abortable('status.board', {}, { signal: controller.signal });
    controller.abort();

    expect(await pending).toEqual({
      ok: false,
      error: { code: 'INTEGRATION', message: CORE_UNAVAILABLE_MESSAGE },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
