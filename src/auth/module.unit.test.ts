/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai';
import * as sinon from 'sinon';
import type { ExtensionContext, Memento, SecretStorage } from 'vscode';
import { PackageInfo } from '../config/package-info';
import { newVsCodeStub } from '../test/helpers/vscode';
import { createAuthModule } from './module';

describe('createAuthModule', () => {
  afterEach(() => {
    sinon.restore();
  });

  function fakeContext(): ExtensionContext {
    return {
      secrets: {
        get: sinon.stub().resolves(undefined),
        store: sinon.stub().resolves(),
        delete: sinon.stub().resolves(),
        onDidChange: sinon.stub(),
      } as Partial<SecretStorage> as SecretStorage,
      globalState: {
        keys: sinon.stub().returns([]),
        get: sinon.stub().returns(undefined),
        update: sinon.stub().resolves(),
      } as Partial<Memento> as ExtensionContext['globalState'],
    } as Partial<ExtensionContext> as ExtensionContext;
  }

  const packageInfo: PackageInfo = {
    publisher: 'google',
    name: 'colab',
    version: '0.0.1-test',
  };

  it('returns an auth provider and disposables', () => {
    const vs = newVsCodeStub();
    vs.window.createStatusBarItem.returns({
      dispose: sinon.stub(),
      show: sinon.stub(),
      hide: sinon.stub(),
    } as unknown as ReturnType<typeof vs.window.createStatusBarItem>);
    const result = createAuthModule(vs.asVsCode(), fakeContext(), packageInfo);

    expect(result.authProvider).to.exist;
    expect(result.disposables).to.be.an('array').with.length.greaterThan(0);
  });
});
