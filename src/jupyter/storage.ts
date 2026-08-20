/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode from 'vscode';
import { z } from 'zod';
import { Shape, Variant } from '../colab/types';
import { PROVIDER_ID } from '../config/constants';
import { ColabAssignedServer } from './servers';

/**
 * Secret-storage key holding the servers of the account that was signed in
 * before multi-account support existed. Migrated into a scoped key on first
 * access so upgrading users keep their assigned servers.
 */
const LEGACY_ASSIGNED_SERVERS_KEY = `${PROVIDER_ID}.assigned_servers`;

/**
 * Builds the secret-storage key holding the assigned servers of one account.
 *
 * @param scope - The active account's email, or undefined when signed out.
 * @returns The storage key to read and write.
 */
function assignedServersKey(scope: string | undefined): string {
  return scope
    ? `${LEGACY_ASSIGNED_SERVERS_KEY}.${scope}`
    : LEGACY_ASSIGNED_SERVERS_KEY;
}
const AssignedServers = z.array(
  z.object({
    id: z.string(),
    label: z.string().nonempty(),
    variant: z.enum(Variant),
    accelerator: z.string().optional(),
    shape: z.enum(Shape).optional(),
    version: z.string().optional(),
    endpoint: z.string().nonempty(),
    connectionInformation: z.object({
      baseUrl: z.string().nonempty(),
      token: z.string().nonempty(),
      tokenExpiry: z.coerce.date(),
      headers: z
        .record(z.string().nonempty(), z.string().nonempty())
        .optional(),
    }),
    dateAssigned: z.coerce.date(),
  }),
);

/**
 * Server storage for Colab Jupyter servers.
 *
 * Servers are stored per Google account, so switching the active account swaps
 * in that account's servers rather than leaking the previous account's ones
 * (whose connection tokens would not authenticate anyway).
 *
 * Implementation assumes full ownership over the backing secret storage file.
 */
export class ServerStorage {
  private cache?: { scope: string; servers: ColabAssignedServer[] };
  private migratedScopes = new Set<string>();

  /**
   * Initializes a new instance.
   *
   * @param vs - The VS Code API instance.
   * @param secrets - The secret storage instance.
   * @param getScope - Returns the active account's email. Read on every access
   * so that switching accounts takes effect immediately, without needing to
   * re-wire this instance.
   */
  constructor(
    private readonly vs: typeof vscode,
    private readonly secrets: vscode.SecretStorage,
    private readonly getScope: () => string | undefined = () => undefined,
  ) {}

  /**
   * List the assigned servers that have been stored.
   *
   * @returns The assigned servers that have been stored.
   */
  async list(): Promise<ColabAssignedServer[]> {
    const scope = this.scope();
    if (this.cache?.scope === scope) {
      return this.cache.servers;
    }
    await this.migrateLegacyServers(scope);
    const serversJson = await this.secrets.get(assignedServersKey(scope));
    const servers = serversJson
      ? AssignedServers.parse(JSON.parse(serversJson))
      : [];
    const res = servers.map((server) => ({
      id: server.id,
      label: server.label,
      variant: server.variant,
      accelerator: server.accelerator,
      shape: server.shape,
      version: server.version,
      endpoint: server.endpoint,
      connectionInformation: {
        baseUrl: this.vs.Uri.parse(server.connectionInformation.baseUrl),
        token: server.connectionInformation.token,
        tokenExpiry: server.connectionInformation.tokenExpiry,
        headers: server.connectionInformation.headers,
      },
      dateAssigned: server.dateAssigned,
    }));
    this.cache = { scope, servers: res };
    return res;
  }

  /**
   * Get a single assigned server by its ID.
   *
   * @param id - The ID of the server to retrieve.
   * @returns The assigned server if found, otherwise undefined.
   */
  async get(id: string): Promise<ColabAssignedServer | undefined> {
    const servers = await this.list();
    return servers.find((server) => server.id === id);
  }

  /**
   * Stores the provided assigned servers.
   *
   * Servers are unique by their ID. If a server with the same ID is already
   * stored, it will be replaced.
   *
   * @param servers - The servers to store.
   * @returns A promise that resolves when the servers have been stored.
   */
  async store(servers: ColabAssignedServer[]): Promise<void> {
    const key = assignedServersKey(this.scope());
    const existingServersJson = await this.secrets.get(key);
    const serversById = mapServersById(existingServersJson);
    for (const server of servers) {
      // This ensures that updating an existing server does not modify the
      // original assignment date.
      const dateAssigned =
        serversById.get(server.id)?.dateAssigned ?? server.dateAssigned;
      serversById.set(server.id, {
        id: server.id,
        label: server.label,
        variant: server.variant,
        accelerator: server.accelerator,
        shape: server.shape,
        version: server.version,
        endpoint: server.endpoint,
        connectionInformation: {
          baseUrl: server.connectionInformation.baseUrl.toString(),
          token: server.connectionInformation.token,
          tokenExpiry: server.connectionInformation.tokenExpiry,
          headers: server.connectionInformation.headers,
        },
        dateAssigned,
      });
    }
    return this.storeServers(
      key,
      Array.from(serversById.values()),
      existingServersJson,
    );
  }

  /**
   * Remove an assigned server.
   *
   * @param serverId - The ID of the server to remove.
   * @returns true if a server was stored and has been removed, or false if the
   * server does not exist.
   */
  async remove(serverId: string): Promise<boolean> {
    const key = assignedServersKey(this.scope());
    const existingServersJson = await this.secrets.get(key);
    const serversById = mapServersById(existingServersJson);
    if (!serversById.delete(serverId)) {
      return false;
    }
    await this.storeServers(
      key,
      Array.from(serversById.values()),
      existingServersJson,
    );
    return true;
  }

  /**
   * Clear all stored servers.
   */
  async clear(): Promise<void> {
    await this.secrets.delete(assignedServersKey(this.scope()));
    this.cache = undefined;
  }

  private scope(): string {
    return this.getScope() ?? '';
  }

  /**
   * Moves servers written before multi-account support into the active
   * account's key, once per account.
   *
   * @param scope - The active account's email, or '' when signed out.
   */
  private async migrateLegacyServers(scope: string): Promise<void> {
    if (!scope || this.migratedScopes.has(scope)) {
      return;
    }
    this.migratedScopes.add(scope);
    const scopedKey = assignedServersKey(scope);
    if (await this.secrets.get(scopedKey)) {
      return;
    }
    const legacyJson = await this.secrets.get(LEGACY_ASSIGNED_SERVERS_KEY);
    if (!legacyJson) {
      return;
    }
    await this.secrets.store(scopedKey, legacyJson);
    await this.secrets.delete(LEGACY_ASSIGNED_SERVERS_KEY);
  }

  private async storeServers(
    key: string,
    servers: z.infer<typeof AssignedServers>,
    existingServersJson: string | undefined,
  ): Promise<void> {
    const serversSorted = servers.sort((a, b) => a.id.localeCompare(b.id));
    const newServersJson = JSON.stringify(serversSorted);
    // Avoid writing the same value to the secrets store.
    if (newServersJson === existingServersJson) {
      return;
    }
    await this.secrets.store(key, newServersJson);
    this.cache = undefined;
  }
}

function mapServersById(json: string | undefined) {
  const servers = json ? AssignedServers.parse(JSON.parse(json)) : [];
  return new Map(servers.map((s) => [s.id, s]));
}
