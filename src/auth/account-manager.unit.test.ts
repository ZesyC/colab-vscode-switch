/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai';
import { GaxiosError, GaxiosResponse } from 'gaxios';
import { OAuth2Client } from 'google-auth-library';
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
import * as sinon from 'sinon';
import { SinonStub, SinonStubbedInstance } from 'sinon';
import type { Memento } from 'vscode';
import {
  AUTHORIZATION_HEADER,
  CONTENT_TYPE_JSON_HEADER,
} from '../colab/headers';
import { AccountManager, ACTIVE_ACCOUNT_KEY } from './account-manager';
import { REQUIRED_SCOPES } from './scopes';
import { AuthStorage, RefreshableAuthenticationSession } from './storage';

const SCOPES = [...REQUIRED_SCOPES];
const USER_INFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const HOUR_MS = 60 * 60 * 1000;

const FIRST: RefreshableAuthenticationSession = {
  id: 'first',
  refreshToken: '1//aa',
  account: { id: 'a@example.com', label: 'A' },
  scopes: SCOPES,
};
const SECOND: RefreshableAuthenticationSession = {
  id: 'second',
  refreshToken: '1//bb',
  account: { id: 'b@example.com', label: 'B' },
  scopes: SCOPES,
};
const THIRD: RefreshableAuthenticationSession = {
  id: 'third',
  refreshToken: '1//cc',
  account: { id: 'c@example.com', label: 'C' },
  scopes: SCOPES,
};

describe('AccountManager', () => {
  let storageStub: SinonStubbedInstance<AuthStorage>;
  let globalState: Memento;
  let loginStub: SinonStub;
  let fetchStub: SinonStub<
    [url: RequestInfo, init?: RequestInit | undefined],
    Promise<Response>
  >;
  let accounts: AccountManager;
  let clientsCreated: OAuth2Client[];

  beforeEach(() => {
    clientsCreated = [];
    fetchStub = sinon.stub(fetch, 'default');
    storageStub = sinon.createStubInstance(AuthStorage);
    storageStub.getSessions.resolves([]);
    storageStub.storeSession.resolves();
    storageStub.removeSession.resolves(undefined);
    globalState = newMementoStub();
    loginStub = sinon.stub();
    accounts = newAccountManager(newFakeClient);
  });

  afterEach(() => {
    fetchStub.restore();
    sinon.restore();
  });

  /**
   * Builds an OAuth2 client whose network calls are stubbed, so each account
   * gets an independent client the test can assert on.
   *
   * @returns A stubbed OAuth2 client.
   */
  function newFakeClient(): OAuth2Client {
    const client = new OAuth2Client('id', 'secret');
    sinon.stub(client, 'refreshAccessToken').callsFake(() => {
      client.credentials = {
        ...client.credentials,
        access_token: `token-for-${client.credentials.refresh_token ?? '?'}`,
        expiry_date: Date.now() + HOUR_MS,
      };
      return undefined as never;
    });
    sinon.stub(client, 'revokeCredentials').resolves();
    clientsCreated.push(client);
    return client;
  }

  function newAccountManager(factory: () => OAuth2Client): AccountManager {
    return new AccountManager(storageStub, globalState, factory, loginStub);
  }

  /**
   * Makes the next sign-in resolve to the given account.
   *
   * @param session - The account the browser flow should yield.
   */
  function stubLoginAs(session: RefreshableAuthenticationSession): void {
    const accessToken = `access-${session.id}`;
    loginStub.resolves({
      refresh_token: session.refreshToken,
      access_token: accessToken,
      expiry_date: Date.now() + HOUR_MS,
      scope: session.scopes.join(' '),
    });
    fetchStub
      .withArgs(USER_INFO_URL, {
        headers: {
          [AUTHORIZATION_HEADER.key]: `Bearer ${accessToken}`,
        },
      })
      .resolves(
        new Response(
          JSON.stringify({
            email: session.account.id,
            name: session.account.label,
          }),
          {
            status: 200,
            headers: {
              [CONTENT_TYPE_JSON_HEADER.key]: CONTENT_TYPE_JSON_HEADER.value,
            },
          },
        ),
      );
  }

  describe('initialize', () => {
    it('returns undefined when nothing is stored', async () => {
      expect(await accounts.initialize()).to.be.undefined;
      expect(accounts.count).to.equal(0);
      expect(accounts.activeEmail).to.be.undefined;
    });

    it('activates the remembered account rather than the first', async () => {
      storageStub.getSessions.resolves([FIRST, SECOND]);
      await globalState.update(ACTIVE_ACCOUNT_KEY, SECOND.id);

      const session = await accounts.initialize();

      expect(session?.id).to.equal(SECOND.id);
      expect(accounts.activeEmail).to.equal(SECOND.account.id);
      expect(accounts.count).to.equal(2);
    });

    it('falls through to the next account when one is revoked', async () => {
      storageStub.getSessions.resolves([FIRST, SECOND]);
      const revoked = new OAuth2Client('id', 'secret');
      sinon.stub(revoked, 'refreshAccessToken').throws(gaxiosError(400));
      sinon.stub(revoked, 'revokeCredentials').resolves();
      let isFirstClient = true;
      accounts = newAccountManager(() => {
        if (isFirstClient) {
          isFirstClient = false;
          return revoked;
        }
        return newFakeClient();
      });

      const session = await accounts.initialize();

      expect(session?.id).to.equal(SECOND.id);
      sinon.assert.calledOnceWithExactly(storageStub.removeSession, FIRST.id);
      expect(accounts.count).to.equal(1);
    });
  });

  describe('signIn', () => {
    it('gives each account its own OAuth2 client', async () => {
      await accounts.initialize();
      stubLoginAs(FIRST);
      await accounts.signIn(SCOPES);
      stubLoginAs(SECOND);
      await accounts.signIn(SCOPES);

      expect(accounts.count).to.equal(2);
      expect(clientsCreated).to.have.lengthOf(2);
      expect(clientsCreated[0].credentials.refresh_token).to.equal(
        FIRST.refreshToken,
      );
      expect(clientsCreated[1].credentials.refresh_token).to.equal(
        SECOND.refreshToken,
      );
    });

    it('makes the newly signed-in account active', async () => {
      storageStub.getSessions.resolves([FIRST]);
      await accounts.initialize();
      stubLoginAs(SECOND);

      await accounts.signIn(SCOPES);

      expect(accounts.activeEmail).to.equal(SECOND.account.id);
      expect(accounts.count).to.equal(2);
    });

    it('updates a known account in place instead of duplicating it', async () => {
      storageStub.getSessions.resolves([FIRST]);
      await accounts.initialize();
      stubLoginAs(FIRST);

      const session = await accounts.signIn(SCOPES);

      expect(session.id).to.equal(FIRST.id);
      expect(accounts.count).to.equal(1);
    });
  });

  describe('nextCandidate', () => {
    beforeEach(async () => {
      storageStub.getSessions.resolves([FIRST, SECOND, THIRD]);
      await accounts.initialize();
    });

    it('never returns the active account', () => {
      expect(accounts.nextCandidate(new Set())).to.not.equal(FIRST.id);
    });

    it('walks accounts in round-robin order after the active one', () => {
      expect(accounts.nextCandidate(new Set())).to.equal(SECOND.id);
      expect(accounts.nextCandidate(new Set([SECOND.id]))).to.equal(THIRD.id);
    });

    it('returns undefined once every account has been tried', () => {
      expect(accounts.nextCandidate(new Set([SECOND.id, THIRD.id]))).to.be
        .undefined;
    });
  });

  describe('setActive', () => {
    it('switches the active account and remembers it', async () => {
      storageStub.getSessions.resolves([FIRST, SECOND]);
      await accounts.initialize();

      const session = await accounts.setActive(SECOND.id);

      expect(session?.account.id).to.equal(SECOND.account.id);
      expect(accounts.activeEmail).to.equal(SECOND.account.id);
      expect(globalState.get<string>(ACTIVE_ACCOUNT_KEY)).to.equal(SECOND.id);
    });

    it('returns undefined for an unknown account', async () => {
      await accounts.initialize();
      expect(await accounts.setActive('nope')).to.be.undefined;
    });
  });

  describe('remove', () => {
    it('promotes the next account when the active one is removed', async () => {
      storageStub.getSessions.resolves([FIRST, SECOND]);
      await accounts.initialize();

      const promoted = await accounts.remove(FIRST.id);

      expect(promoted?.id).to.equal(SECOND.id);
      expect(accounts.activeEmail).to.equal(SECOND.account.id);
      expect(accounts.count).to.equal(1);
    });

    it('leaves no active account when the last one is removed', async () => {
      storageStub.getSessions.resolves([FIRST]);
      await accounts.initialize();

      expect(await accounts.remove(FIRST.id)).to.be.undefined;
      expect(accounts.activeEmail).to.be.undefined;
      expect(globalState.get<string>(ACTIVE_ACCOUNT_KEY)).to.be.undefined;
    });
  });
});

/**
 * Builds a {@link GaxiosError} that {@link classifyRefreshError} treats as
 * unrecoverable.
 *
 * @param status - The HTTP status to report.
 * @returns The error.
 */
function gaxiosError(status: number): GaxiosError {
  const headers = new Headers();
  const url = new URL('https://example.com');
  return new GaxiosError(
    'invalid_grant: Token has been expired or revoked.',
    { headers, url },
    {
      config: { headers, url },
      data: undefined,
      status,
      statusText: 'Bad Request',
      headers,
    } as Partial<GaxiosResponse> as GaxiosResponse,
  );
}

/**
 * Builds an in-memory {@link Memento} for the active-account pointer.
 *
 * @returns A memento backed by a plain map.
 */
function newMementoStub(): Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) =>
      (values.has(key) ? values.get(key) : defaultValue) as T,
    update: (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
  } as Memento;
}
