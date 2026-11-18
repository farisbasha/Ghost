import type { Principal, Scopes } from '../principal';

/** The principal's fields that permissions read; scopes are filled from Phase 4. */
export interface ParsedPrincipal {
  kind: Principal['kind'];
  scopes: Scopes | null;
}

/** `frame.options.context` as the API framework builds it, or already parsed */
type RawContext = Partial<Omit<ParsedContext, 'principal'>> & {
  principal?: Principal | ParsedPrincipal | null;
};

/**
 * Parse Context
 *
 * Utility function, to expand strings out into objects.
 */
export default function parseContext(rawContext?: unknown): ParsedContext {
  // Strings carry no fields, so reading one off 'internal' is undefined
  const context = rawContext as RawContext | undefined;
  const parsed: ParsedContext = {
    internal: false,
    user: null,
    api_key: null,
    integration: null,
    member: null,
    principal: null,
    public: true,
  };

  if (context && (rawContext === 'internal' || context.internal)) {
    parsed.internal = true;
    parsed.public = false;
  }

  if (context && context.user) {
    parsed.user = context.user;
    parsed.public = false;
  }

  if (context && context.api_key) {
    parsed.api_key = context.api_key;
    parsed.integration = context.integration;
    parsed.public = context.api_key.type === 'content';
  }

  if (context && context.member) {
    parsed.member = context.member;
  }

  // canThis parses an already parsed context, so both shapes are read alike
  const principal = context?.principal;
  if (principal) {
    const scopes = 'scopes' in principal ? principal.scopes : null;
    parsed.principal = { kind: principal.kind, scopes: scopes ?? null };

    // A request with a principal is public only when anonymous or a content key
    if (principal.kind !== 'anonymous' && parsed.api_key?.type !== 'content') {
      parsed.public = false;
    }
  }

  return parsed;
}

/** A normalized `frame.options.context` */
export interface ParsedContext {
  internal: boolean;
  user: string | null;
  api_key: { id: string; type: string } | null;
  integration: unknown;
  member: unknown;
  principal: ParsedPrincipal | null;
  public: boolean;
}
