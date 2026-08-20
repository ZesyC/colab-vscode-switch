/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode, { Disposable, StatusBarItem } from 'vscode';
import { MANAGE_ACCOUNTS } from '../colab/commands/constants';
import { Toggleable } from '../common/toggleable';
import { GoogleAuthProvider } from './auth-provider';

const ACCOUNT_STATUS_BAR_ID = 'colab.account';

/**
 * Shows which Google account Colab is currently using.
 *
 * With automatic account failover the active account can change without the
 * user doing anything, so it must be visible at a glance.
 */
export class AccountStatusBar implements Toggleable, Disposable {
  private readonly statusBarItem: StatusBarItem;
  private readonly authListener: Disposable;
  private isDisposed = false;

  /**
   * Initializes a new instance.
   *
   * @param vs - The VS Code API instance.
   * @param authProvider - Supplies the active account and its change event.
   */
  constructor(
    private readonly vs: typeof vscode,
    private readonly authProvider: GoogleAuthProvider,
  ) {
    this.statusBarItem = vs.window.createStatusBarItem(
      ACCOUNT_STATUS_BAR_ID,
      vs.StatusBarAlignment.Right,
    );
    this.statusBarItem.name = 'Colab Account';
    this.statusBarItem.command = MANAGE_ACCOUNTS.id;
    this.update();
    this.authListener = authProvider.onDidChangeSessions(() => {
      this.update();
    });
  }

  /**
   * Disposes of the status bar item, cleaning up any resources.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.authListener.dispose();
    this.statusBarItem.dispose();
    this.isDisposed = true;
  }

  /**
   * Shows the status bar item.
   */
  on(): void {
    this.update();
    this.statusBarItem.show();
  }

  /**
   * Hides the status bar item.
   */
  off(): void {
    this.statusBarItem.hide();
  }

  private update(): void {
    if (this.isDisposed) {
      return;
    }
    const email = this.authProvider.activeAccountEmail;
    if (!email) {
      this.statusBarItem.text = '$(account) Colab: signed out';
      this.statusBarItem.tooltip = 'Sign in to Colab';
      return;
    }
    const total = this.authProvider.accountCount;
    // The trailing count signals that failover accounts are standing by.
    this.statusBarItem.text = `$(account) ${shorten(email)}${
      total > 1 ? ` +${(total - 1).toString()}` : ''
    }`;
    this.statusBarItem.tooltip = new this.vs.MarkdownString(
      [
        `Colab is using **${email}**.`,
        total > 1
          ? `${total.toString()} accounts signed in. Click to switch.`
          : 'Click to add another account.',
      ].join('\n\n'),
    );
  }
}

/**
 * Trims an email to keep the status bar compact.
 *
 * @param email - The full email address.
 * @returns The local part when the email is long, otherwise the email itself.
 */
function shorten(email: string): string {
  if (email.length <= 24) {
    return email;
  }
  return email.split('@')[0];
}
