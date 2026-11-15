import type { IncomingMessage } from "node:http";
import type { TeamIdentity } from "./team-auth.js";

/** What the team auth core hands a provider so it never needs the core's internals. */
export interface IdentityProviderContext {
  /** The engine origin, for building redirect URIs. */
  origin: string;
  now(): number;
  /** Format a session-safe Set-Cookie value with the engine's cookie attributes. */
  cookie(name: string, value: string, seconds: number): string;
  /** Resolve a workspace member by user id, or null. */
  lookupUser(id: string): TeamIdentity | null;
}

/**
 * An external sign-in provider (for example SAML from an enterprise plugin). The built-in OIDC
 * sign-in is unchanged and is used when no provider is installed. A provider owns its own
 * state and cookies; the core only issues the session after the provider names a workspace member.
 */
export interface IdentityProvider {
  readonly id: string;
  /** Start sign-in: return where to send the browser and the cookie that binds this browser to the attempt. */
  begin(ctx: IdentityProviderContext): Promise<{ url: string; setCookie: string }>;
  /**
   * Finish sign-in. Return the workspace user id to sign in, plus any cookies to clear.
   * Throw a TeamAuthError to refuse. The core rejects ids that are not workspace members.
   */
  complete(params: URLSearchParams, req: Pick<IncomingMessage, "headers">, ctx: IdentityProviderContext): Promise<{ userId: string; clearCookies?: string[] }>;
}

let installed: IdentityProvider | undefined;
/** Install an identity provider. Call with no argument to remove it and restore built-in OIDC only. */
export function setTeamIdentityProvider(provider?: IdentityProvider): void { installed = provider; }
export function getTeamIdentityProvider(): IdentityProvider | undefined { return installed; }
