/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode from 'vscode';
import { GoogleAuthProvider } from '../auth/auth-provider';
import { log } from '../common/logging';
import { MANAGE_ACCOUNTS } from './commands/constants';

/** Configuration section holding the multi-account settings. */
export const MULTI_ACCOUNT_SECTION = 'colab.multiAccount';

/**
 * Switches the extension over to another signed-in Google account when the
 * active one can no longer serve a request.
 *
 * Kept behind an interface so {@link AssignmentManager} does not depend on the
 * authentication stack, which would be circular.
 */
export interface AccountFailover {
  /** Whether automatic switching is enabled by the user. */
  isEnabled(): boolean;

  /** Whether the exhausted account's servers should be deleted before switching. */
  shouldReleaseServers(): boolean;

  /** The session ID of the account currently in use. */
  activeAccountId(): string | undefined;

  /**
   * Whether another account is available to take over.
   *
   * @param exclude - Session IDs already tried during this assignment.
   */
  hasAlternatives(exclude: ReadonlySet<string>): boolean;

  /**
   * Activates the next available account.
   *
   * @param exclude - Session IDs already tried during this assignment.
   * @param reason - Human-readable reason, surfaced to the user.
   * @returns The session ID now active, or undefined if no switch happened.
   */
  switchToNext(
    exclude: ReadonlySet<string>,
    reason: string,
  ): Promise<string | undefined>;
}

/**
 * The default {@link AccountFailover}, backed by the extension's Google
 * accounts and the `colab.multiAccount.*` settings.
 */
export class QuotaFailoverController implements AccountFailover {
  /**
   * Initializes a new instance.
   *
   * @param vs - The VS Code API instance.
   * @param authProvider - Owns the signed-in accounts and the active one.
   */
  constructor(
    private readonly vs: typeof vscode,
    private readonly authProvider: GoogleAuthProvider,
  ) {}

  /**
   * Whether automatic switching is enabled by the user.
   *
   * @returns True when `colab.multiAccount.autoSwitch` is on.
   */
  isEnabled(): boolean {
    return this.setting('autoSwitch', true);
  }

  /**
   * Whether the exhausted account's servers should be deleted before switching.
   *
   * @returns True when `colab.multiAccount.releaseServersOnSwitch` is on.
   */
  shouldReleaseServers(): boolean {
    return this.setting('releaseServersOnSwitch', true);
  }

  /**
   * The session ID of the account currently in use.
   *
   * @returns The active session ID, or undefined when signed out.
   */
  activeAccountId(): string | undefined {
    return this.authProvider.listAccounts().find((a) => a.isActive)?.id;
  }

  /**
   * Whether another account is available to take over.
   *
   * @param exclude - Session IDs already tried during this assignment.
   * @returns True if at least one untried account remains.
   */
  hasAlternatives(exclude: ReadonlySet<string>): boolean {
    return this.authProvider.nextAccountCandidate(exclude) !== undefined;
  }

  /**
   * Activates the next available account and tells the user about it.
   *
   * @param exclude - Session IDs already tried during this assignment.
   * @param reason - Human-readable reason, surfaced to the user.
   * @returns The session ID now active, or undefined if no switch happened.
   */
  async switchToNext(
    exclude: ReadonlySet<string>,
    reason: string,
  ): Promise<string | undefined> {
    const previous = this.authProvider.activeAccountEmail;
    const candidate = this.authProvider.nextAccountCandidate(exclude);
    if (!candidate) {
      return undefined;
    }
    const session = await this.authProvider.switchAccount(candidate);
    if (!session) {
      log.warn(`Failed to switch to account ${candidate}.`);
      return undefined;
    }
    log.info(
      `${reason} Switched from ${previous ?? 'unknown'} to ${session.account.id}.`,
    );
    void this.notifySwitched(previous, session.account.id, reason);
    return session.id;
  }

  private async notifySwitched(
    from: string | undefined,
    to: string,
    reason: string,
  ): Promise<void> {
    const action = await this.vs.window.showWarningMessage(
      `${reason} Switched to ${to}${from ? ` (was ${from})` : ''} and re-created the server with the same settings.`,
      MANAGE_ACCOUNTS.label,
    );
    if (action === MANAGE_ACCOUNTS.label) {
      await this.vs.commands.executeCommand(MANAGE_ACCOUNTS.id);
    }
  }

  private setting(key: string, fallback: boolean): boolean {
    return this.vs.workspace
      .getConfiguration(MULTI_ACCOUNT_SECTION)
      .get<boolean>(key, fallback);
  }
}
