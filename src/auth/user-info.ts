/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fetch from 'node-fetch';
import { z } from 'zod';
import { AUTHORIZATION_HEADER } from '../colab/headers';

const USER_INFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * User information queried for following a successful login.
 */
export const UserInfoSchema = z.object({
  name: z.string(),
  email: z.string(),
});

/** The profile of an authenticated Google user. */
export type UserInfo = z.infer<typeof UserInfoSchema>;

/**
 * Fetches the profile of the user owning the provided access token.
 *
 * @param token - A valid Google OAuth2 access token.
 * @returns The user's name and email.
 * @throws Error if the request fails.
 */
export async function getUserInfo(token: string): Promise<UserInfo> {
  const response = await fetch(USER_INFO_URL, {
    headers: {
      [AUTHORIZATION_HEADER.key]: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch user info: ${response.statusText}. Response: ${errorText}`,
    );
  }
  const json: unknown = await response.json();
  return UserInfoSchema.parse(json);
}
