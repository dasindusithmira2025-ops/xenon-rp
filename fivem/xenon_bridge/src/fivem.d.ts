/**
 * The slice of the FiveM server API this resource uses.
 *
 * Declared locally rather than pulled from `@citizenfx/server`: that package is
 * large, versioned against the game build, and this bridge uses nine functions.
 * Writing them out keeps the resource buildable from a clean checkout with no
 * game-specific dependency, and makes the surface it depends on explicit.
 */

/**
 * The player who triggered the event currently being handled.
 *
 * FXServer sets this global before invoking a handler and reuses it for the
 * next one, so read it synchronously at the top of a handler and keep the
 * value - by the time an `await` resumes it belongs to somebody else.
 */
declare const source: number;

declare function on(event: string, handler: (...args: never[]) => void): void;
declare function emitNet(event: string, target: number, ...args: unknown[]): void;
declare function RegisterCommand(
  name: string,
  handler: (source: number, args: string[], raw: string) => void,
  restricted: boolean,
): void;

declare function GetConvar(name: string, fallback: string): string;
declare function GetPlayerName(source: string): string;
declare function GetNumPlayerIdentifiers(source: string): number;
declare function GetPlayerIdentifier(source: string, index: number): string;
declare function getPlayers(): string[];

/** Deferral handle passed to a `playerConnecting` handler. */
interface Deferrals {
  defer(): void;
  update(message: string): void;
  /** Called with no argument to admit, or with a reason to refuse. */
  done(reason?: string): void;
}

interface HttpRequest {
  readonly address: string;
  readonly headers: Record<string, string | undefined>;
  readonly method: string;
  readonly path: string;
  setDataHandler(handler: (body: string) => void): void;
}

interface HttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  send(body: string): void;
}

declare function setHttpHandler(
  handler: (request: HttpRequest, response: HttpResponse) => void,
): void;
