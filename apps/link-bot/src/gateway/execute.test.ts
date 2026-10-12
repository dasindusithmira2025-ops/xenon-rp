import { DiscordAPIError } from 'discord.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { GATEWAY_BODY_LIMIT_BYTES, signServiceRequest, type ServiceName } from '@xenon/contracts';
import { silentLogger } from '@xenon/logger';

import { createGatewayExecutor, type GatewayExecutor } from './execute';
import { GatewayFailure, type GatewayHandlers } from './operations';

const SECRET = 's'.repeat(40);
const GUILD = '100000000000000001';
const MEMBER = '300000000000000003';

let handlers: Record<string, Mock>;
let execute: GatewayExecutor;

beforeEach(() => {
  handlers = {
    'member.roles': vi.fn().mockResolvedValue({ roleIds: [GUILD] }),
    'member.role': vi
      .fn()
      .mockRejectedValue(
        new GatewayFailure('FORBIDDEN_TARGET', 'Link never manages @everyone.', false),
      ),
    'guild.info': vi
      .fn()
      .mockRejectedValue(
        new DiscordAPIError({ code: 50013, message: 'x' }, 50013, 403, 'GET', '/x', {}),
      ),
    'channel.send': vi.fn().mockRejectedValue(new Error('boom')),
  };
  execute = createGatewayExecutor({
    secret: SECRET,
    handlers: handlers as unknown as GatewayHandlers,
    logger: silentLogger,
  });
});

interface Options {
  readonly secret?: string;
  readonly service?: ServiceName;
  readonly signedPath?: string;
  readonly body?: string;
}

function signed(operation: string, payload: unknown, options: Options = {}) {
  const body = options.body ?? JSON.stringify(payload);
  const headers: Record<string, string> = {
    ...signServiceRequest(options.secret ?? SECRET, {
      service: options.service ?? 'worker',
      method: 'POST',
      path: options.signedPath ?? `/gateway/v1/${operation}`,
      body,
    }),
  };
  return { operation, body, header: (name: string) => headers[name] ?? null, headers };
}

describe('gateway executor', () => {
  it('runs a signed worker request through the handler', async () => {
    const request = signed('member.roles', { discordUserId: MEMBER });
    expect(await execute(request)).toEqual({
      status: 200,
      response: { ok: true, data: { roleIds: [GUILD] } },
    });
    expect(handlers['member.roles']).toHaveBeenCalledWith({ discordUserId: MEMBER });
  });

  it('answers 401 for a wrong secret, wrong service or wrong operation path', async () => {
    const attempts = [
      signed('member.roles', { discordUserId: MEMBER }, { secret: 'x'.repeat(40) }),
      signed('member.roles', { discordUserId: MEMBER }, { service: 'link' }),
      signed('member.roles', { discordUserId: MEMBER }, { signedPath: '/gateway/v1/guild.info' }),
    ];
    for (const attempt of attempts) {
      expect(await execute(attempt)).toMatchObject({
        status: 401,
        response: { ok: false, error: { code: 'UNAUTHENTICATED' } },
      });
    }
    expect(handlers['member.roles']).not.toHaveBeenCalled();
  });

  it('answers 401 when the signature headers are missing', async () => {
    const result = await execute({
      operation: 'member.roles',
      body: JSON.stringify({ discordUserId: MEMBER }),
      header: () => null,
    });
    expect(result.status).toBe(401);
  });

  it('rejects a reused nonce with 409', async () => {
    const request = signed('member.roles', { discordUserId: MEMBER });
    expect((await execute(request)).status).toBe(200);
    expect(await execute(request)).toMatchObject({
      status: 409,
      response: { ok: false, error: { code: 'UNAUTHENTICATED' } },
    });
    expect(handlers['member.roles']).toHaveBeenCalledTimes(1);
  });

  it('does not burn a nonce on a failed signature', async () => {
    const request = signed('member.roles', { discordUserId: MEMBER });
    const forged = {
      ...request,
      header: (name: string) =>
        name === 'x-xenon-service-signature' ? 'f'.repeat(64) : request.header(name),
    };
    expect((await execute(forged)).status).toBe(401);
    expect((await execute(request)).status).toBe(200);
  });

  it('answers 413 for an oversized body before doing any work', async () => {
    const request = signed('member.roles', {
      discordUserId: MEMBER,
      padding: 'x'.repeat(GATEWAY_BODY_LIMIT_BYTES),
    });
    expect(await execute(request)).toMatchObject({
      status: 413,
      response: { ok: false, error: { code: 'VALIDATION' } },
    });
  });

  it('reports an unknown operation only after authentication', async () => {
    expect((await execute(signed('admin.nuke', {}))).status).toBe(404);
    expect(
      (await execute({ operation: 'admin.nuke', body: '{}', header: () => null })).status,
    ).toBe(401);
  });

  it('answers 400 for a body that is not JSON', async () => {
    expect((await execute(signed('member.roles', null, { body: 'not json' }))).status).toBe(400);
  });

  it('answers 422 when the input fails the operation schema', async () => {
    expect(await execute(signed('member.roles', { discordUserId: 'nope' }))).toMatchObject({
      status: 422,
      response: { ok: false, error: { code: 'VALIDATION' } },
    });
  });

  it('maps policy refusals and Discord errors to status and code', async () => {
    const refused = await execute(
      signed('member.role', { discordUserId: MEMBER, roleId: GUILD, action: 'add', reason: 'r' }),
    );
    expect(refused).toMatchObject({
      status: 403,
      response: { ok: false, error: { code: 'FORBIDDEN_TARGET', retryable: false } },
    });

    const discord = await execute(signed('guild.info', {}));
    expect(discord).toMatchObject({
      status: 422,
      response: {
        ok: false,
        error: { code: 'DISCORD_ERROR', discordCode: 50013, retryable: false },
      },
    });
  });

  it('turns an unexpected handler crash into a retryable 503 and never rejects', async () => {
    handlers['guild.info']?.mockRejectedValue(new Error('boom'));
    const crashed = await execute(signed('guild.info', {}));
    expect(crashed).toMatchObject({
      status: 503,
      response: { ok: false, error: { code: 'DISCORD_UNAVAILABLE', retryable: true } },
    });
  });

  it('answers 500 retryable when the pipeline itself throws', async () => {
    const throwing = createGatewayExecutor({
      secret: SECRET,
      handlers: handlers as unknown as GatewayHandlers,
      logger: silentLogger,
      now: () => {
        throw new Error('clock exploded');
      },
    });
    expect(await throwing(signed('member.roles', { discordUserId: MEMBER }))).toMatchObject({
      status: 500,
      response: { ok: false, error: { code: 'DISCORD_UNAVAILABLE', retryable: true } },
    });
  });
  it('never serializes Discord request bodies from errors into logs', async () => {
    const secretText = 'private-message-content';
    const unsafeError = Object.assign(new Error('Discord unavailable'), {
      requestBody: { json: { content: secretText } },
      status: 503,
    });
    handlers['guild.info']?.mockRejectedValue(unsafeError);
    const warn = vi.fn();
    const safeExecute = createGatewayExecutor({
      secret: SECRET,
      handlers: handlers as unknown as GatewayHandlers,
      logger: { ...silentLogger, warn },
    });

    await safeExecute(signed('guild.info', {}));

    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretText);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorName: 'Error', httpStatus: 503 }),
      'Gateway operation failed',
    );
  });
});
