/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OAuth2Client } from 'google-auth-library';
import vscode, { Disposable, ExtensionContext } from 'vscode';
import { CONFIG } from '../colab-config';
import { Toggleable } from '../common/toggleable';
import { PackageInfo } from '../config/package-info';
import { AccountManager } from './account-manager';
import { AccountStatusBar } from './account-status-bar';
import { GoogleAuthProvider } from './auth-provider';
import { getOAuth2Flows } from './flows/flows';
import { login, LoginOptions } from './login';
import { AuthStorage } from './storage';

/** The result of activating the auth module. */
export interface AuthModule {
  /** The {@link GoogleAuthProvider} for downstream wiring. */
  readonly authProvider: GoogleAuthProvider;
  /** Disposables that should be pushed into `context.subscriptions`. */
  readonly disposables: Disposable[];
  /** Auth-gated toggles that should be passed to `whileAuthorized`. */
  readonly toggles: Toggleable[];
}

/**
 * Builds the {@link GoogleAuthProvider} and its supporting OAuth2 flow
 * components. The returned `disposables` should be pushed into
 * `context.subscriptions`.
 *
 * @param vs - The VS Code API instance.
 * @param context - The extension context (for `secrets` and `globalState`).
 * @param packageInfo - Information about the installed extension.
 * @returns The auth provider and its associated disposables.
 */
export function createAuthModule(
  vs: typeof vscode,
  context: ExtensionContext,
  packageInfo: PackageInfo,
): AuthModule {
  const newOAuth2Client = () =>
    new OAuth2Client(CONFIG.ClientId, CONFIG.ClientNotSoSecret);
  // A dedicated client drives the interactive browser flow. It never holds a
  // particular account's credentials: `getToken()` returns them instead of
  // storing them, so it is safe to share across accounts. Each signed-in
  // account gets its own client for refreshes, owned by the AccountManager.
  const loginClient = newOAuth2Client();
  const authFlows = getOAuth2Flows(vs, packageInfo, loginClient);
  const accounts = new AccountManager(
    new AuthStorage(context.secrets),
    context.globalState,
    newOAuth2Client,
    (scopes: string[], options?: LoginOptions) =>
      login(vs, authFlows, loginClient, scopes, options),
  );
  const authProvider = new GoogleAuthProvider(vs, accounts);
  const accountStatusBar = new AccountStatusBar(vs, authProvider);
  const flowsDisposable: Disposable = {
    dispose: () => {
      for (const flow of authFlows) {
        flow.dispose?.();
      }
    },
  };
  return {
    authProvider,
    disposables: [flowsDisposable, accountStatusBar, authProvider],
    toggles: [accountStatusBar],
  };
}
