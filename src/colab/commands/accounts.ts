/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode, { QuickPickItem } from 'vscode';
import { ManagedAccount } from '../../auth/account-manager';
import { GoogleAuthProvider } from '../../auth/auth-provider';
import { log } from '../../common/logging';
import { ADD_ACCOUNT, SWITCH_ACCOUNT } from './constants';

/** A quick-pick entry that either targets an account or triggers an action. */
interface AccountPick extends QuickPickItem {
  readonly accountId?: string;
  readonly action?: 'add' | 'remove';
}

/**
 * Signs in an additional Google account and makes it active.
 *
 * @param authProvider - The authentication provider.
 */
export async function addAccount(
  authProvider: GoogleAuthProvider,
): Promise<void> {
  const session = await authProvider.addAccount();
  log.info(`Added Colab account ${session.account.id}.`);
}

/**
 * Prompts for another signed-in account and makes it active.
 *
 * Offers to add an account when fewer than two are signed in.
 *
 * @param vs - The VS Code API instance.
 * @param authProvider - The authentication provider.
 */
export async function switchAccount(
  vs: typeof vscode,
  authProvider: GoogleAuthProvider,
): Promise<void> {
  const accounts = authProvider.listAccounts();
  const others = accounts.filter((a) => !a.isActive);
  if (others.length === 0) {
    const add = await vs.window.showInformationMessage(
      accounts.length === 0
        ? 'No Google account is signed in.'
        : 'Only one Google account is signed in. Add another to be able to switch.',
      ADD_ACCOUNT.label,
    );
    if (add === ADD_ACCOUNT.label) {
      await addAccount(authProvider);
    }
    return;
  }
  const pick = await vs.window.showQuickPick<AccountPick>(others.map(toPick), {
    title: SWITCH_ACCOUNT.label,
    placeHolder: 'Select the Google account to use for Colab',
  });
  if (!pick?.accountId) {
    return;
  }
  await activate(vs, authProvider, pick.accountId);
}

/**
 * Shows every signed-in account and lets the user switch, add, or remove one.
 *
 * @param vs - The VS Code API instance.
 * @param authProvider - The authentication provider.
 */
export async function manageAccounts(
  vs: typeof vscode,
  authProvider: GoogleAuthProvider,
): Promise<void> {
  const accounts = authProvider.listAccounts();
  const items: AccountPick[] = accounts.map(toPick);
  items.push(
    { label: '', kind: vs.QuickPickItemKind.Separator },
    {
      label: `$(add) ${ADD_ACCOUNT.label}`,
      detail: ADD_ACCOUNT.description,
      action: 'add',
    },
  );
  if (accounts.length > 0) {
    items.push({
      label: '$(trash) Remove Account...',
      detail: 'Sign out of one account and revoke its credentials.',
      action: 'remove',
    });
  }
  const pick = await vs.window.showQuickPick<AccountPick>(items, {
    title: 'Colab Accounts',
    placeHolder: 'Select an account to make active, or choose an action',
  });
  if (!pick) {
    return;
  }
  if (pick.action === 'add') {
    await addAccount(authProvider);
    return;
  }
  if (pick.action === 'remove') {
    await removeAccount(vs, authProvider);
    return;
  }
  if (pick.accountId) {
    await activate(vs, authProvider, pick.accountId);
  }
}

/**
 * Prompts for an account to sign out of and removes it.
 *
 * @param vs - The VS Code API instance.
 * @param authProvider - The authentication provider.
 */
export async function removeAccount(
  vs: typeof vscode,
  authProvider: GoogleAuthProvider,
): Promise<void> {
  const accounts = authProvider.listAccounts();
  if (accounts.length === 0) {
    return;
  }
  const pick = await vs.window.showQuickPick<AccountPick>(
    accounts.map(toPick),
    {
      title: 'Remove Colab Account',
      placeHolder: 'Select the account to sign out of',
    },
  );
  if (!pick?.accountId) {
    return;
  }
  await authProvider.removeSession(pick.accountId);
  const active = authProvider.activeAccountEmail;
  void vs.window.showInformationMessage(
    active
      ? `Removed ${pick.label}. Now using ${active}.`
      : `Removed ${pick.label}. No Google account is signed in.`,
  );
}

async function activate(
  vs: typeof vscode,
  authProvider: GoogleAuthProvider,
  accountId: string,
): Promise<void> {
  const session = await authProvider.switchAccount(accountId);
  if (!session) {
    void vs.window.showErrorMessage(
      'Failed to switch account. It may need to be signed in again.',
    );
    return;
  }
  void vs.window.showInformationMessage(
    `Colab is now using ${session.account.id}.`,
  );
}

function toPick(account: ManagedAccount): AccountPick {
  return {
    label: account.email,
    description: account.isActive ? '$(check) active' : account.label,
    accountId: account.id,
  };
}
