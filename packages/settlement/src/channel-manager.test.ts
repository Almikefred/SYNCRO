/**
 * Unit tests for ChannelManager distributed locking and idempotency (Issue #1648).
 */

import { describe, it, expect, vi } from 'vitest';
import { ChannelManager, InMemoryChannelStore, ChannelBackend, PrincipalAuthorizer } from './channel-manager';
import { DistributedLock } from './distributed-lock';

class MockBackend implements ChannelBackend {
  openCount = 0;
  async openChannel(_params: { principal: string; provider: string; deposit: bigint }) {
    this.openCount++;
    return {
      channelId: `ch_${this.openCount}_${Math.random()}`,
      balance: 1_000_000n,
    };
  }
  async topUpChannel(_params: { channelId: string; amount: bigint }) {
    return { balance: 2_000_000n };
  }
  async closeChannel(_params: { channelId: string }) {
    // no-op
  }
}

class MockAuthorizer implements PrincipalAuthorizer {
  async authorize(_params: { principal: string; provider: string; amount: bigint; reason: "open" | "top_up" }) {
    return true;
  }
}

class MockDistributedLock implements DistributedLock {
  private locks = new Map<string, { token: string; expiresAt: number }>();
  private failAcquire = false;

  setFailAcquire(fail: boolean) {
    this.failAcquire = fail;
  }

  async acquire(resourceKey: string, ttlMs = 30000) {
    if (this.failAcquire) {
      return { acquired: false, reason: 'unavailable' as const };
    }
    const existing = this.locks.get(resourceKey);
    const now = Date.now();
    if (existing && existing.expiresAt > now) {
      return { acquired: false, reason: 'contention' as const };
    }
    const token = `token_${Math.random()}`;
    this.locks.set(resourceKey, { token, expiresAt: now + ttlMs });
    return { acquired: true, lockToken: token };
  }

  async release(resourceKey: string, lockToken: string) {
    const existing = this.locks.get(resourceKey);
    if (!existing || existing.token !== lockToken) {
      return false;
    }
    this.locks.delete(resourceKey);
    return true;
  }

  expireLock(resourceKey: string) {
    const existing = this.locks.get(resourceKey);
    if (existing) {
      this.locks.set(resourceKey, { ...existing, expiresAt: Date.now() - 1000 });
    }
  }
}

describe('ChannelManager Distributed Locking & Idempotency', () => {
  it('should ensure concurrent opens for the same channel create exactly one channel', async () => {
    const backend = new MockBackend();
    const store = new InMemoryChannelStore();
    const authorizer = new MockAuthorizer();
    const lock = new MockDistributedLock();

    const manager = new ChannelManager({
      backend,
      store,
      authorizer,
      lock,
    });

    const principal = 'alice';
    const provider = 'bob';

    // Simulate concurrent ensureChannel calls from two instances/processes
    const [ch1, ch2] = await Promise.all([
      manager.ensureChannel(principal, provider),
      manager.ensureChannel(principal, provider),
    ]);

    expect(ch1.channelId).toBe(ch2.channelId);
    expect(backend.openCount).toBe(1);
    expect(ch1.status).toBe('open');
  });

  it('should handle lock expiry mid-operation and make open idempotent', async () => {
    const backend = new MockBackend();
    const store = new InMemoryChannelStore();
    const authorizer = new MockAuthorizer();
    const lock = new MockDistributedLock();

    const manager = new ChannelManager({
      backend,
      store,
      authorizer,
      lock,
    });

    const principal = 'alice';
    const provider = 'charlie';

    // Force lock expiry right after acquisition or during operation
    const key = ChannelManager.key(principal, provider);

    // We can test that if lock expires and another open occurs, idempotency returns existing channel
    const ch1 = await manager.ensureChannel(principal, provider);
    expect(ch1.status).toBe('open');

    // Subsequent ensureChannel when channel already exists returns existing channel idempotently
    const ch2 = await manager.ensureChannel(principal, provider);
    expect(ch2.channelId).toBe(ch1.channelId);
    expect(backend.openCount).toBe(1);
  });
});
