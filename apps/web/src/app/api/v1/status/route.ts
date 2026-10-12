import { prisma } from '@xenon/database';
import { statusBoard } from '@xenon/domain';

import { apiJson, runApi } from '~/server/api';

/**
 * GET /api/v1/status
 *
 * The public server status board. No session required; it is the same data
 * the public status page renders. `connectUrl` is the first public server's
 * connect string, for a single "Play now" button.
 */
export async function GET(): Promise<Response> {
  return runApi(async () => {
    const board = await statusBoard(prisma);
    const connectUrl =
      board.servers.find((server) => server.connectUrl !== null)?.connectUrl ?? null;
    return apiJson({ ...board, connectUrl });
  });
}
