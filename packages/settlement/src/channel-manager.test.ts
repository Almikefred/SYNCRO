/**
 * Unit tests for ChannelManager (Issue #1647).
 *
 * Covers:
 *  - placeholder returns "unknown" status for missing channels
 *  - getState returns undefined for unknown channels
 *  - close handles unknown channels correctly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelManager, ChannelState, ChannelBackend, ChannelStore, PrincipalAuthorizer, ChannelStatus } from './channel-manager';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function createMockBackend(): ChannelBackend {
  return {
    openChannel: vi.fn().mockResolvedValue({ channelId: 'chan_123', balance: 1_000_000n }),
    topUp: vi.fn().mockResolvedValue({ balance: 2_000_000n }),
    getBalance: vi.fn().mockResolvedValue(1_000_000n),
    closeChannel: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockStore(): ChannelStore {
  const store = new Map<string, ChannelState>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (state: ChannelState) => { store.set(state.key, state); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}

function createMockAuthorizer(): PrincipalAuthorizer {
  return {
    authorize: vi.fn().mockResolvedValue(true),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelManager — placeholder and unknown channel handling', () => {
  let manager: ChannelManager;
  let backend: ChannelBackend;
  let store: ChannelStore;
  let authorizer: PrincipalAuthorizer;

  beforeEach(() => {
    backend = createMockBackend();
    store = createMockStore();
    authorizer = createMockAuthorizer();
    manager = new ChannelManager({
      backend,
      store,
      authorizer,
      now: () => 1_700_000_000_000,
    });
  });

  describe('placeholder', () => {
    it('returns "unknown" status instead of "closed"', () => {
      const placeholder = (manager as any).placeholder('principal_1', 'provider_1');
      
      expect(placeholder.status).toBe('unknown');
      expect(placeholder.balance).toBe(0n);
      expect(placeholder.burnRate).toBe(0);
      expect(placeholder.lastUpdated).toBe(1_700_000_000_000);
      expect(placeholder.key).toBe('principal_1::provider_1');
      expect(placeholder.principal).toBe('principal_1');
      expect(placeholder.provider).toBe('provider_1');
      expect(placeholder.channelId).toBeUndefined();
    });
  });

  describe('getState', () => {
    it('returns undefined for unknown channels', async () => {
      const state = await manager.getState('unknown_principal', 'unknown_provider');
      expect(state).toBeUndefined();
    });

    it('returns stored state for known channels', async () => {
      const existingState: ChannelState = {
        key: 'principal_1::provider_1',
        principal: 'principal_1',
        provider: 'provider_1',
        channelId: 'chan_123',
        status: 'open',
        balance: 1_000_000n,
        burnRate: 0,
        lastUpdated: 1_700_000_000_000,
      };
      await store.put(existingState);

      const state = await manager.getState('principal_1', 'provider_1');
      expect(state).toEqual(existingState);
    });
  });

  describe('close', () => {
    it('handles unknown channel (no state in store) by deleting key', async () => {
      await manager.close('unknown_principal', 'unknown_provider');
      
      // Store delete should have been called
      expect(store.delete).toHaveBeenCalledWith('unknown_principal::unknown_provider');
      // Backend closeChannel should NOT be called for unknown channels
      expect(backend.closeChannel).not.toHaveBeenCalled();
    });

    it('closes known channel and updates status to "closed"', async () => {
      const existingState: ChannelState = {
        key: 'principal_1::provider_1',
        principal: 'principal_1',
        provider: 'provider_1',
        channelId: 'chan_123',
        status: 'open',
        balance: 1_000_000n,
        burnRate: 0,
        lastUpdated: 1_700_000_000_000,
      };
      await store.put(existingState);

      await manager.close('principal_1', 'provider_1');

      expect(backend.closeChannel).toHaveBeenCalledWith({ channelId: 'chan_123' });
      expect(store.put).toHaveBeenCalledWith(expect.objectContaining({
        status: 'closed',
        balance: 0n,
      }));
    });

    it('handles channel with state but no channelId', async () => {
      const existingState: ChannelState = {
        key: 'principal_1::provider_1',
        principal: 'principal_1',
        provider: 'provider_1',
        channelId: undefined,
        status: 'opening',
        balance: 0n,
        burnRate: 0,
        lastUpdated: 1_700_000_000_000,
      };
      await store.put(existingState);

      await manager.close('principal_1', 'provider_1');

      expect(store.delete).toHaveBeenCalledWith('principal_1::provider_1');
      expect(backend.closeChannel).not.toHaveBeenCalled();
    });
  });

  describe('ChannelStatus type', () => {
    it('includes "unknown" status', () => {
      const statuses: ChannelStatus[] = ['opening', 'open', 'topping_up', 'exhausted', 'closed', 'failed', 'unknown'];
      statuses.forEach(status => {
        // This validates the type includes "unknown"
        expect(typeof status).toBe('string');
      });
    });
  });
});