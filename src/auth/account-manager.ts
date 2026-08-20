/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GaxiosError } from 'gaxios';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuid } from 'uuid';
import { AuthenticationSession, Memento } from 'vscode';
import { log } from '../common/logging';
import { Credentials, LoginOptions } from './login';
import { AuthStorage, RefreshableAuthenticationSession } from './storage';
import { getUserInfo } from './user-info';

/** Memento key holding the ID of the account that is currently active. */
export const ACTIVE_ACCOUNT_KEY = 'colab.activeAccountId';

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

/** A Google account known to the extension. */
export interface ManagedAccount {
  /** The stable session ID of the account. */
  readonly id: string;
  /** The account's email address. */
  readonly email: string;
  /** The account's display name. */
  readonly label: string;
  /** The scopes the account was authorized with. */
  readonly scopes: readonly string[];
  /** Whether this is the account currently issuing Colab requests. */
  readonly isActive: boolean;
}

/**
 * Owns every signed-in Google account and the notion of which one is "active".
 *
 * Only the active account is ever exposed to VS Code's authentication API, so
 * downstream consumers (the Colab clients, the Jupyter server provider, ...)
 * keep working unchanged and transparently follow whichever account is active.
 *
 * Each account gets its own {@link OAuth2Client}, because an OAuth2Client holds
 * the credentials of a single user; sharing one across accounts would make
 * refreshes clobber each other.
 */
export class AccountManager {
  private readonly clients = new Map<string, OAuth2Client>();
  /** Stored (persistent) sessions, keyed by session ID. */
  private stored = new Map<string, RefreshableAuthenticationSession>();
  /** Live sessions holding a fresh access token, keyed by session ID. */
  private readonly live = new Map<string, AuthenticationSession>();
  private activeId?: string;

  /**
   * Initializes a new instance.
   *
   * @param storage - Persistent storage for refreshable sessions.
   * @param globalState - Memento used to remember the active account across
   * reloads.
   * @param createOAuth2Client - Factory producing a fresh, credential-less
   * OAuth2 client.
   * @param login - Runs the interactive browser sign-in flow.
   */
  constructor(
    private readonly storage: AuthStorage,
    private readonly globalState: Memento,
    private readonly createOAuth2Client: () => OAuth2Client,
    private readonly login: (
      scopes: string[],
      options?: LoginOptions,
    ) => Promise<Credentials>,
  ) {}

  /**
   * The email of the active account, used to scope per-account state such as
   * assigned servers. Synchronous so callers can use it as a storage key.
   *
   * @returns The active account's email, or undefined when signed out.
   */
  get activeEmail(): string | undefined {
    if (!this.activeId) {
      return undefined;
    }
    return this.stored.get(this.activeId)?.account.id;
  }

  /**
   * The number of accounts the user has signed in to.
   *
   * @returns The account count.
   */
  get count(): number {
    return this.stored.size;
  }

  /**
   * Loads persisted accounts and restores (or elects) the active account.
   *
   * The active account's token is refreshed eagerly; other accounts are
   * refreshed lazily when they become active.
   *
   * @returns The active session, or undefined when no account is signed in.
   */
  async initialize(): Promise<AuthenticationSession | undefined> {
    const sessions = await this.storage.getSessions();
    this.stored = new Map(sessions.map((s) => [s.id, s]));
    if (this.stored.size === 0) {
      this.activeId = undefined;
      return undefined;
    }
    const remembered = this.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
    const candidates =
      remembered && this.stored.has(remembered)
        ? [remembered, ...this.stored.keys()]
        : [...this.stored.keys()];
    // Try each account in turn: one revoked account must not brick activation.
    for (const id of candidates) {
      const session = await this.activate(id);
      if (session) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Lists every signed-in account, the active one first.
   *
   * @returns The known accounts.
   */
  list(): ManagedAccount[] {
    const accounts = [...this.stored.values()].map((s) => ({
      id: s.id,
      email: s.account.id,
      label: s.account.label,
      scopes: s.scopes,
      isActive: s.id === this.activeId,
    }));
    return accounts.sort((a, b) => Number(b.isActive) - Number(a.isActive));
  }

  /**
   * Looks up an account's display info without making it active.
   *
   * @param id - The session ID.
   * @returns The account, or undefined if unknown.
   */
  get(id: string): ManagedAccount | undefined {
    return this.list().find((a) => a.id === id);
  }

  /**
   * Gets the active session, refreshing its access token when it is near or
   * past expiry.
   *
   * @returns The active session, or undefined when none is active.
   * @throws The refresh error when the token cannot be refreshed.
   */
  async getActiveSession(): Promise<AuthenticationSession | undefined> {
    if (!this.activeId) {
      return undefined;
    }
    const session = this.live.get(this.activeId);
    if (!session) {
      return undefined;
    }
    const expiryDateMs = this.clients.get(this.activeId)?.credentials
      .expiry_date;
    if (expiryDateMs && expiryDateMs > Date.now() + REFRESH_MARGIN_MS) {
      return session;
    }
    return this.refreshOrDrop(this.activeId);
  }

  /**
   * Makes an account active, refreshing its access token.
   *
   * @param id - The session ID of the account to activate.
   * @returns The now-active session, or undefined if it could not be refreshed.
   */
  async setActive(id: string): Promise<AuthenticationSession | undefined> {
    if (!this.stored.has(id)) {
      return undefined;
    }
    return this.activate(id);
  }

  /**
   * Runs the interactive sign-in flow and stores the resulting account, making
   * it active.
   *
   * @param scopes - The scopes to authorize.
   * @param options - Login options. Pass `forceAccountChooser` to add an
   * account other than the one already signed in to the browser.
   * @returns The newly active session.
   */
  async signIn(
    scopes: string[],
    options?: LoginOptions,
  ): Promise<AuthenticationSession> {
    const credentials = await this.login(scopes, options);
    const user = await getUserInfo(credentials.access_token);
    // Re-authorizing an account we already know updates it in place rather than
    // creating a duplicate entry.
    const existing = [...this.stored.values()].find(
      (s) => s.account.id === user.email,
    );
    const session: RefreshableAuthenticationSession = {
      id: existing?.id ?? uuid(),
      refreshToken: credentials.refresh_token,
      account: { id: user.email, label: user.name },
      scopes,
    };
    await this.storage.storeSession(session);
    this.stored.set(session.id, session);

    const client = this.newClientFor(session);
    client.setCredentials(credentials);
    this.clients.set(session.id, client);
    const live: AuthenticationSession = {
      id: session.id,
      accessToken: credentials.access_token,
      account: session.account,
      scopes,
    };
    this.live.set(session.id, live);
    await this.markActive(session.id);
    return live;
  }

  /**
   * Removes an account, revoking its credentials.
   *
   * If the removed account was active, the next remaining account becomes
   * active.
   *
   * @param id - The session ID of the account to remove.
   * @returns The session that became active, or undefined if none remain.
   */
  async remove(id: string): Promise<AuthenticationSession | undefined> {
    const client = this.clients.get(id);
    if (client) {
      try {
        await client.revokeCredentials();
      } catch {
        // The token may already be expired or revoked. Removal proceeds either
        // way, since the user must sign in again regardless.
      }
    }
    await this.storage.removeSession(id);
    this.stored.delete(id);
    this.clients.delete(id);
    this.live.delete(id);
    if (this.activeId !== id) {
      return this.activeId ? this.live.get(this.activeId) : undefined;
    }
    this.activeId = undefined;
    for (const next of this.stored.keys()) {
      const session = await this.activate(next);
      if (session) {
        return session;
      }
    }
    await this.globalState.update(ACTIVE_ACCOUNT_KEY, undefined);
    return undefined;
  }

  /**
   * Picks the account that should take over from the active one, e.g. after it
   * runs out of quota.
   *
   * Accounts are tried in a stable round-robin order starting after the active
   * account, so repeated fallbacks walk through every account instead of
   * retrying the same one.
   *
   * @param exclude - Session IDs that have already been tried and failed.
   * @returns The session ID to try next, or undefined when none is left.
   */
  nextCandidate(exclude: ReadonlySet<string>): string | undefined {
    const ids = [...this.stored.keys()];
    if (ids.length === 0) {
      return undefined;
    }
    const start = this.activeId ? ids.indexOf(this.activeId) + 1 : 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[(start + i) % ids.length];
      if (id !== this.activeId && !exclude.has(id)) {
        return id;
      }
    }
    return undefined;
  }

  private async activate(
    id: string,
  ): Promise<AuthenticationSession | undefined> {
    const session = await this.refreshOrDrop(id);
    if (!session) {
      return undefined;
    }
    await this.markActive(id);
    return session;
  }

  /**
   * Refreshes an account's token, forgetting the account entirely when the
   * refresh token is no longer usable (e.g. the grant was revoked).
   *
   * @param id - The session ID to refresh.
   * @returns The refreshed session, or undefined if the account was dropped.
   * @throws The original error when the failure is transient.
   */
  private async refreshOrDrop(
    id: string,
  ): Promise<AuthenticationSession | undefined> {
    try {
      return await this.refresh(id);
    } catch (err: unknown) {
      const { shouldClear, reason } = classifyRefreshError(err);
      if (!shouldClear) {
        log.error(`Unable to refresh access token for account ${id}`, err);
        throw err;
      }
      log.warn(`${reason} for account ${id}. Removing it.`, err);
      await this.drop(id);
      return undefined;
    }
  }

  private async drop(id: string): Promise<void> {
    await this.storage.removeSession(id);
    this.stored.delete(id);
    this.clients.delete(id);
    this.live.delete(id);
    if (this.activeId === id) {
      this.activeId = undefined;
      await this.globalState.update(ACTIVE_ACCOUNT_KEY, undefined);
    }
  }

  private async refresh(id: string): Promise<AuthenticationSession> {
    const stored = this.stored.get(id);
    if (!stored) {
      throw new Error(`No stored account with ID ${id}`);
    }
    let client = this.clients.get(id);
    if (!client) {
      client = this.newClientFor(stored);
      this.clients.set(id, client);
    }
    await client.refreshAccessToken();
    const accessToken = client.credentials.access_token;
    if (!accessToken) {
      throw new Error('Failed to refresh Google OAuth token.');
    }
    const session: AuthenticationSession = {
      id,
      accessToken,
      account: stored.account,
      scopes: stored.scopes,
    };
    this.live.set(id, session);
    return session;
  }

  private newClientFor(
    session: RefreshableAuthenticationSession,
  ): OAuth2Client {
    const client = this.createOAuth2Client();
    client.setCredentials({
      refresh_token: session.refreshToken,
      token_type: 'Bearer',
      scope: session.scopes.join(' '),
    });
    return client;
  }

  private async markActive(id: string): Promise<void> {
    this.activeId = id;
    await this.globalState.update(ACTIVE_ACCOUNT_KEY, id);
  }
}

/**
 * Determines whether a refresh failure means the account is unusable and must
 * be dropped, as opposed to a transient failure.
 *
 * @param err - The error thrown while refreshing.
 * @returns Whether to clear the account, and why.
 */
export function classifyRefreshError(err: unknown): {
  shouldClear: boolean;
  reason: string;
} {
  if (
    err instanceof GaxiosError &&
    err.status === 400 &&
    err.message.includes('invalid_grant')
  ) {
    return {
      shouldClear: true,
      reason: 'OAuth app access to Colab was revoked',
    };
  }
  // This should only ever be the case when a developer builds from source.
  if (err instanceof GaxiosError && err.status === 401) {
    return { shouldClear: true, reason: 'The configured OAuth client changed' };
  }
  return { shouldClear: false, reason: '' };
}
