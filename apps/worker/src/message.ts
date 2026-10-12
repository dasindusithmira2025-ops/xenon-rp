import type { GatewayInput } from '@xenon/contracts';

/**
 * Build a gateway message body from discord.js builder output.
 *
 * Builders produce typed API objects (`APIEmbed`, action rows); the gateway
 * contract carries them as plain JSON records. Serialising once here is both
 * the type conversion and a guarantee that nothing but JSON crosses the wire.
 */

export type GatewayMessage = GatewayInput<'message.send'>['message'];

export interface MessageParts {
  readonly content?: string;
  readonly embeds?: readonly object[];
  readonly components?: readonly object[];
  /** Role snowflakes this message may ping. Every other mention is suppressed by Link. */
  readonly allowedRoleMentions?: readonly string[];
}

export function gatewayMessage(parts: MessageParts): GatewayMessage {
  // Parsed JSON is plain data by construction; the record type is its shape.
  const json = JSON.parse(JSON.stringify(parts)) as GatewayMessage;
  return json;
}
