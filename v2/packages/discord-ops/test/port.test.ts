import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DiscordPort } from '../src/index.js';

const portSource = readFileSync(fileURLToPath(new URL('../src/port.ts', import.meta.url)), 'utf8');

/**
 * Compile-time probe: this literal only satisfies DiscordPort while the
 * port declares exactly these eighteen methods — an extra method is an
 * excess property error, a missing one an absent property error.
 */
const portProbe: DiscordPort = {
  async createRole() {
    throw new Error('probe');
  },
  async deleteRole() {
    throw new Error('probe');
  },
  async createCategory() {
    throw new Error('probe');
  },
  async deleteCategory() {
    throw new Error('probe');
  },
  async createTextChannel() {
    throw new Error('probe');
  },
  async deleteChannel() {
    throw new Error('probe');
  },
  async editOverwrites() {
    throw new Error('probe');
  },
  async sendMessage() {
    throw new Error('probe');
  },
  async pinMessage() {
    throw new Error('probe');
  },
  async addRoleToMember() {
    throw new Error('probe');
  },
  async removeRoleFromMember() {
    throw new Error('probe');
  },
  async moveChannel() {
    throw new Error('probe');
  },
  async renameChannel() {
    throw new Error('probe');
  },
  async fetchAuditEntries() {
    throw new Error('probe');
  },
  async fetchChannelMessages() {
    throw new Error('probe');
  },
  async fetchGuildRoles() {
    throw new Error('probe');
  },
  async fetchGuildChannels() {
    throw new Error('probe');
  },
  async fetchMember() {
    throw new Error('probe');
  },
};

describe('the Discord port contract', () => {
  it('declares exactly the eighteen plain-data methods', () => {
    expect(Object.keys(portProbe).sort()).toEqual([
      'addRoleToMember',
      'createCategory',
      'createRole',
      'createTextChannel',
      'deleteCategory',
      'deleteChannel',
      'deleteRole',
      'editOverwrites',
      'fetchAuditEntries',
      'fetchChannelMessages',
      'fetchGuildChannels',
      'fetchGuildRoles',
      'fetchMember',
      'moveChannel',
      'pinMessage',
      'removeRoleFromMember',
      'renameChannel',
      'sendMessage',
    ]);
  });

  it('imports nothing at all — no apps, no discord.js, only plain data', () => {
    // The port is deliberately self-contained so no library or app type
    // can leak into the contract; the catalogue owns the cross-package types.
    expect(portSource).not.toMatch(/\bimport\b|\brequire\s*\(/);
  });
});
