import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  buildUsageResponseFromQueueRecords,
  mergeUsageResponses,
  mergeUsageResponseWithMissingDetails,
} from '../../../src/cliproxy/services/usage-compatibility-transformer';
import {
  extractCliproxyUsageHistoryDetails,
  mergeCliproxyUsageHistoryDetails,
  normalizeCliproxyUsageHistoryDetail,
} from '../../../src/web-server/usage/cliproxy-usage-transformer';

const record = {
  timestamp: '2026-09-01T00:00:00Z',
  provider: 'test',
  model: 'test-model',
  source: 'provider-account',
  auth_index: 'upstream-account',
  tokens: { input_tokens: 10, output_tokens: 2 },
  failed: false,
};

describe('CLIProxy client-key attribution', () => {
  let directory: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    originalHome = process.env.CCS_HOME;
    directory = mkdtempSync(join(tmpdir(), 'ccs-attribution-test-'));
    process.env.CCS_HOME = directory;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CCS_HOME;
    else process.env.CCS_HOME = originalHome;
    rmSync(directory, { recursive: true, force: true });
  });
  it('hashes inbound keys without confusing them with provider accounts', () => {
    const response = buildUsageResponseFromQueueRecords([
      { ...record, api_key: 'synthetic-key-a' },
    ]);
    const detail = response.usage!.apis!.test.models!['test-model'].details![0];
    expect(detail.client_key_id).toBe(createHash('sha256').update('synthetic-key-a').digest('hex'));
    expect(detail.auth_index).toBe('upstream-account');
    expect(JSON.stringify(response)).not.toContain('synthetic-key-a');
  });

  it('keeps identical requests from different keys through merge, history and reload', () => {
    const a = buildUsageResponseFromQueueRecords([{ ...record, api_key: 'synthetic-key-a' }]);
    const b = buildUsageResponseFromQueueRecords([{ ...record, api_key: 'synthetic-key-b' }]);
    const merged = mergeUsageResponses(a, b);
    expect(merged.usage!.total_requests).toBe(2);
    expect(mergeUsageResponseWithMissingDetails(a, b).usage!.total_requests).toBe(2);
    const accounts = new Map([['upstream-account', 'provider-account']]);
    const history = extractCliproxyUsageHistoryDetails(merged, accounts);
    expect(new Set(history.map((detail) => detail.clientKeyId)).size).toBe(2);
    expect(history.every((detail) => detail.accountId === 'provider-account')).toBe(true);
    const saved = mergeCliproxyUsageHistoryDetails([history[0]], [history[1]]);
    expect(saved).toHaveLength(2);
    const restored = JSON.parse(JSON.stringify(saved)).map(normalizeCliproxyUsageHistoryDetail);
    expect(restored).toEqual(saved);
    expect(mergeCliproxyUsageHistoryDetails(saved, history)).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain('synthetic-key');
    expect(saved.reduce((sum, detail) => sum + detail.inputTokens, 0)).toBe(20);
  });

  it('leaves missing or invalid keys unattributed and supports legacy history', () => {
    for (const api_key of [undefined, null, '', ' ', 123]) {
      const response = buildUsageResponseFromQueueRecords([{ ...record, api_key }]);
      const history = extractCliproxyUsageHistoryDetails(response);
      expect(history[0].clientKeyId).toBeUndefined();
      expect(normalizeCliproxyUsageHistoryDetail(history[0])).toEqual(history[0]);
      expect(
        normalizeCliproxyUsageHistoryDetail({ ...history[0], clientKeyId: 'raw-key' })?.clientKeyId
      ).toBeUndefined();
    }
  });
});
