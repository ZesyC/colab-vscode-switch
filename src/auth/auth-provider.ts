/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode, {
  AuthenticationProvider,
  AuthenticationProviderAuthenticationSessionsChangeEvent,
  AuthenticationProviderSessionOptions,
  AuthenticationSession,
  Disposable,
  Event,
  EventEmitter,
} from 'vscode';
import { log } from '../common/logging';
import { Toggleable } from '../common/toggleable';
import { telemetry } from '../telemetry';
import { AccountManager, ManagedAccount } from './account-manager';
import { areScopesAllowed, ALLOWED_SCOPES, REQUIRED_SCOPES } from './scopes';

const PROVIDER_ID = 'google';
const PROVIDER_LABEL = 'Google';

/**
 * An {@link Event} which fires when an authentication session is added,
 * removed, or changed.
 */
export interface AuthChangeEvent
  extends AuthenticationProviderAuthenticationSessionsChangeEvent {
  /**
   * True when there is a valid {@link AuthenticationSession} for the
   * {@link AuthenticationProvider}.
   */
  hasValidSession: boolean;
}

/**
 * Provides authentication using Google OAuth2.
 *
 * Registers itself with the VS Code authentication API and emits events when
 * authentication sessions change.
 *
 * Several Google accounts may be signed in at once, but only one is *active* at
 * a time; the provider exposes exactly that account to VS Code. Account
 * bookkeeping lives in {@link AccountManager}; this class is the VS Code-facing
 * adapter over it.
 *
 * Session access tokens are refreshed JIT upon access if they are near or past
 * their expiry.
 */
export class GoogleAuthProvider implements AuthenticationProvider, Disposable {
  readonly onDidChangeSessions: Event<AuthChangeEvent>;
  private isDisposed = false;
  private isInitialized = false;
  private authProvider?: Disposable;
  private readonly emitter: EventEmitter<AuthChangeEvent>;
  private session?: Readonly<AuthenticationSession>;
  private readonly disposeController = new AbortController();
  private readonly disposeSignal: AbortSignal = this.disposeController.signal;

  /**
   * Initializes the GoogleAuthProvider.
   *
   * @param vs - The VS Code API.
   * @param accounts - Manages the signed-in Google accounts.
   */
  constructor(
    private readonly vs: typeof vscode,
    private readonly accounts: AccountManager,
  ) {
    this.emitter = new vs.EventEmitter<AuthChangeEvent>();
    this.onDidChangeSessions = this.emitter.event;

    this.onDidChangeSessions(() => {
      void this.setSignedInContext();
    });
  }

  /**
   * Retrieves the Google OAuth2 authentication session.
   *
   * @param vs - The VS Code API.
   * @param scopes - The required scopes for the authentication session
   * @returns The authentication session.
   */
  static async getOrCreateSession(
    vs: typeof vscode,
    scopes: readonly string[],
  ): Promise<AuthenticationSession> {
    const session = await vs.authentication.getSession(PROVIDER_ID, scopes, {
      createIfNone: true,
    });
    return session;
  }

  /**
   * The email of the account currently issuing Colab requests.
   *
   * @returns The active account's email, or undefined when signed out.
   */
  get activeAccountEmail(): string | undefined {
    return this.accounts.activeEmail;
  }

  /**
   * The number of Google accounts currently signed in.
   *
   * @returns The account count.
   */
  get accountCount(): number {
    return this.accounts.count;
  }

  /**
   * Disposes the provider and cleans up resources.
   */
  dispose() {
    this.isDisposed = true;
    this.authProvider?.dispose();
    this.disposeController.abort(new Error('GoogleAuthProvider was disposed.'));
  }

  /**
   * Initializes the provider by restoring the active account from storage and
   * refreshing its access token.
   */
  async initialize() {
    this.guardDisposed();
    if (this.disposeSignal.aborted) {
      throw this.disposeSignal.reason;
    }
    if (this.isInitialized) {
      return;
    }

    this.session = await this.accounts.initialize();
    this.isInitialized = true;
    if (this.session) {
      this.emitter.fire({
        added: [],
        removed: [],
        changed: [this.session],
        hasValidSession: true,
      });
    }
    this.register();
  }

  /**
   * Sets the state of the toggles based on the authentication session.
   *
   * @param toggles - The toggles to manage based on authorization status.
   * @returns A {@link Disposable} that can be used to stop toggling the
   * provided toggles when there are changes to the authorization status.
   */
  whileAuthorized(...toggles: Toggleable[]): Disposable {
    this.guardDisposed();
    this.assertReady();
    const setToggles = () => {
      if (this.session === undefined) {
        toggles.forEach((t) => {
          t.off();
        });
      } else {
        toggles.forEach((t) => {
          t.on();
        });
      }
    };
    const listener = this.onDidChangeSessions(setToggles);
    // Call the function initially to set the correct state.
    setToggles();
    return listener;
  }

  /**
   * Get the list of managed sessions.
   *
   * Only the active account is returned; other signed-in accounts are switched
   * to explicitly via {@link GoogleAuthProvider.switchAccount}.
   *
   * The session's access token is refreshed if it is near or past its expiry.
   *
   * @param scopes - An optional array of scopes. If provided, the sessions
   * returned will match these permissions. Otherwise, all sessions are
   * returned.
   * @param options - Additional options for getting sessions. If an account is
   * passed in, sessions returned are limited to it.
   * @returns An array of managed authentication sessions.
   */
  async getSessions(
    scopes: readonly string[] | undefined,
    options: AuthenticationProviderSessionOptions,
  ): Promise<AuthenticationSession[]> {
    this.guardDisposed();
    this.assertReady();
    if (
      !this.session ||
      !areScopesAllowed(scopes) ||
      // Checks if provided scopes are a subset of the current session's scopes
      (scopes && !scopes.every((r) => this.session?.scopes.includes(r)))
    ) {
      return [];
    }
    try {
      const refreshed = await this.accounts.getActiveSession();
      if (!refreshed) {
        // The active account was dropped mid-refresh (e.g. access revoked).
        this.setSession(undefined, /* removed= */ this.session);
        return [];
      }
      this.session = refreshed;
    } catch (err: unknown) {
      log.error('Unable to refresh access token', err);
    }
    if (options.account && this.session.account.id !== options.account.id) {
      return [];
    }
    return [this.session];
  }

  /**
   * Creates and stores an authentication session with the given scopes.
   *
   * @param scopes - Scopes required for the session. All values must be
   * in {@link ALLOWED_SCOPES}
   * @returns The created session.
   * @throws An error if login fails.
   */
  async createSession(scopes: string[]): Promise<AuthenticationSession> {
    return this.signIn(scopes, /* asAdditionalAccount= */ false);
  }

  /**
   * Signs in an *additional* Google account and makes it active.
   *
   * Google's account chooser is forced so the user can pick an account other
   * than the one their browser is already signed in to.
   *
   * @param scopes - Scopes to authorize. Defaults to {@link REQUIRED_SCOPES}.
   * @returns The newly active session.
   */
  async addAccount(
    scopes: readonly string[] = REQUIRED_SCOPES,
  ): Promise<AuthenticationSession> {
    return this.signIn([...scopes], /* asAdditionalAccount= */ true);
  }

  /**
   * Lists every signed-in account, the active one first.
   *
   * @returns The known accounts.
   */
  listAccounts(): ManagedAccount[] {
    this.guardDisposed();
    return this.accounts.list();
  }

  /**
   * Makes another signed-in account active. All subsequent Colab requests use
   * its credentials.
   *
   * @param accountId - The session ID of the account to activate.
   * @returns The now-active session, or undefined if it could not be activated.
   */
  async switchAccount(
    accountId: string,
  ): Promise<AuthenticationSession | undefined> {
    this.guardDisposed();
    this.assertReady();
    if (accountId === this.session?.id) {
      return this.session;
    }
    const previous = this.session;
    const next = await this.accounts.setActive(accountId);
    if (!next) {
      return undefined;
    }
    log.info(
      `Switched active Colab account to ${next.account.id}` +
        (previous ? ` (from ${previous.account.id})` : ''),
    );
    // Reported as a removal *and* an addition so that consumers keyed on the
    // account (assigned servers, tree views, Jupyter connections) fully reset
    // instead of carrying the previous account's state over.
    this.session = next;
    this.emitter.fire({
      added: [next],
      removed: previous ? [previous] : [],
      changed: [],
      hasValidSession: true,
    });
    return next;
  }

  /**
   * Picks the next account that should take over from the active one.
   *
   * @param exclude - Session IDs already tried and known to be unusable.
   * @returns The session ID to try next, or undefined when none is left.
   */
  nextAccountCandidate(
    exclude: ReadonlySet<string> = new Set(),
  ): string | undefined {
    return this.accounts.nextCandidate(exclude);
  }

  /**
   * Removes a session by ID.
   *
   * This will revoke the credentials (if the matching session is managed) and
   * remove the session from storage. If other accounts remain, the next one
   * becomes active.
   *
   * @param sessionId - The session ID.
   * @returns A promise that resolves when the session is removed.
   */
  async removeSession(sessionId: string): Promise<void> {
    this.guardDisposed();
    this.assertReady();
    const removed = this.accounts.get(sessionId);
    if (!removed) {
      return;
    }
    const removedSession =
      this.session?.id === sessionId ? this.session : undefined;
    const next = await this.accounts.remove(sessionId);
    if (removedSession) {
      this.setSession(next, removedSession);
    }
  }

  /**
   * Signs out of the active Google authentication session.
   *
   * If other accounts are signed in, the next one becomes active rather than
   * leaving the extension signed out.
   */
  async signOut() {
    this.guardDisposed();
    if (!this.session) {
      return;
    }
    telemetry.logSignOut();
    await this.removeSession(this.session.id);
  }

  /**
   * Signs out of every Google account.
   */
  async signOutAll() {
    this.guardDisposed();
    this.assertReady();
    telemetry.logSignOut();
    for (const account of this.accounts.list()) {
      await this.accounts.remove(account.id);
    }
    const removedSession = this.session;
    if (removedSession) {
      this.setSession(undefined, removedSession);
    }
  }

  private async signIn(
    scopes: string[],
    asAdditionalAccount: boolean,
  ): Promise<AuthenticationSession> {
    this.guardDisposed();
    this.assertReady();
    try {
      const sortedScopes = Array.from(new Set(scopes).values()).sort();
      if (!areScopesAllowed(sortedScopes)) {
        throw new Error(
          `Only supports the following scopes: ${Array.from(ALLOWED_SCOPES.values()).join(', ')}`,
        );
      }

      if (
        sortedScopes.length < REQUIRED_SCOPES.length ||
        !REQUIRED_SCOPES.every((r) => sortedScopes.includes(r))
      ) {
        throw new Error(
          `Sessions must request at least the required scopes: ${Array.from(REQUIRED_SCOPES.values()).join(', ')}`,
        );
      }
      const previous = this.session;
      // Incremental auth re-uses the active account's grant, which is exactly
      // what we want when *widening scopes*, and exactly what we must avoid
      // when *adding a second account*.
      const newSession = await this.accounts.signIn(sortedScopes, {
        includeGrantedScopes: !asAdditionalAccount && !!previous,
        loginHint:
          !asAdditionalAccount && previous ? previous.account.id : undefined,
        ...(asAdditionalAccount ? { forceAccountChooser: true } : {}),
      });
      const isSameAccount = previous?.account.id === newSession.account.id;
      this.session = newSession;
      this.emitter.fire({
        added: isSameAccount ? [] : [newSession],
        removed: isSameAccount || !previous ? [] : [previous],
        changed: isSameAccount ? [newSession] : [],
        hasValidSession: true,
      });
      this.vs.window.showInformationMessage(
        `Signed in to Google as ${newSession.account.id}!`,
      );
      return newSession;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      this.vs.window.showErrorMessage(`Sign in failed: ${msg}`);
      throw err;
    }
  }

  private setSession(
    next: AuthenticationSession | undefined,
    removed: AuthenticationSession,
  ) {
    this.session = next;
    this.emitter.fire({
      added: next ? [next] : [],
      removed: [removed],
      changed: [],
      hasValidSession: !!next,
    });
  }

  private guardDisposed() {
    if (this.isDisposed) {
      throw new Error(
        'Cannot use GoogleAuthProvider after it has been disposed',
      );
    }
  }

  private register() {
    this.authProvider = this.vs.authentication.registerAuthenticationProvider(
      PROVIDER_ID,
      PROVIDER_LABEL,
      this,
      // VS Code only ever sees the *active* account. Additional accounts are
      // managed by this extension's own commands, which keeps every consumer of
      // `authentication.getSession()` transparently pointed at the active one.
      { supportsMultipleAccounts: false },
    );
  }

  private async setSignedInContext() {
    await this.vs.commands.executeCommand(
      'setContext',
      'colab.isSignedIn',
      !!this.session,
    );
  }

  private assertReady(): void {
    if (!this.isInitialized) {
      throw new Error(`Must call initialize() first.`);
    }
    if (this.disposeSignal.aborted) {
      throw this.disposeSignal.reason;
    }
  }
}
