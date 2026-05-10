import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the 'redis' module before importing RedisClient so that the client
// under test receives our spy-equipped mock instead of a real connection.
// ---------------------------------------------------------------------------
const mockRedis = {
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  hGetAll: vi.fn(),
  hSet: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  zIncrBy: vi.fn().mockResolvedValue(5000),
  zRangeWithScores: vi.fn().mockResolvedValue([]),
  zRem: vi.fn().mockResolvedValue(1),
  keys: vi.fn().mockResolvedValue([]),
  lPush: vi.fn().mockResolvedValue(1),
  lTrim: vi.fn().mockResolvedValue('OK'),
  lRange: vi.fn().mockResolvedValue([]),
  xAdd: vi.fn().mockResolvedValue('1-0'),
};

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockRedis),
}));

import { RedisClient } from './redis-client.js';

describe('RedisClient', () => {
  let client: RedisClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set sane defaults so individual tests can override selectively
    mockRedis.hGetAll.mockResolvedValue({});
    mockRedis.zRangeWithScores.mockResolvedValue([]);
    mockRedis.keys.mockResolvedValue([]);
    mockRedis.lRange.mockResolvedValue([]);
    client = new RedisClient('redis://localhost:6379');
  });

  // ---------------------------------------------------------------------------
  // updateCellDwell — Bug 2 fix: must use zIncrBy (sorted set), not hSet
  // ---------------------------------------------------------------------------

  describe('updateCellDwell', () => {
    it('calls zIncrBy to accumulate dwell time per object', async () => {
      await client.updateCellDwell('col-01', 'cam-01', 'G_05_03', 'obj-A', 3000);

      expect(mockRedis.zIncrBy).toHaveBeenCalledOnce();
      const [key, score, member] = mockRedis.zIncrBy.mock.calls[0];
      expect(key).toBe('cell:col-01:cam-01:G_05_03');
      expect(score).toBe(3000);
      expect(member).toBe('obj-A');
    });

    it('sets a 24-hour TTL on the cell key', async () => {
      await client.updateCellDwell('col-01', 'cam-01', 'G_05_03', 'obj-A', 1000);

      expect(mockRedis.expire).toHaveBeenCalledWith('cell:col-01:cam-01:G_05_03', 86400);
    });

    it('does not call hSet (was the broken behaviour)', async () => {
      await client.updateCellDwell('col-01', 'cam-01', 'G_05_03', 'obj-A', 1000);
      expect(mockRedis.hSet).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getCellStats — Bug 2 fix: must use zRangeWithScores, not hGetAll
  // ---------------------------------------------------------------------------

  describe('getCellStats', () => {
    it('reads cell keys with zRangeWithScores', async () => {
      mockRedis.keys.mockResolvedValue(['cell:col-01:cam-01:G_05_03']);
      mockRedis.zRangeWithScores.mockResolvedValue([
        { value: 'obj-A', score: 5000 },
        { value: 'obj-B', score: 3000 },
      ]);

      await client.getCellStats('col-01', 'cam-01');

      expect(mockRedis.zRangeWithScores).toHaveBeenCalledWith('cell:col-01:cam-01:G_05_03', 0, -1);
      expect(mockRedis.hGetAll).not.toHaveBeenCalled(); // was the broken call
    });

    it('computes total, count, avg, max and min correctly', async () => {
      mockRedis.keys.mockResolvedValue(['cell:col-01:cam-01:G_05_03']);
      mockRedis.zRangeWithScores.mockResolvedValue([
        { value: 'obj-A', score: 6000 },
        { value: 'obj-B', score: 2000 },
        { value: 'obj-C', score: 4000 },
      ]);

      const stats = await client.getCellStats('col-01', 'cam-01');

      expect(stats).toHaveLength(1);
      const s = stats[0];
      expect(s.grid_cell_id).toBe('G_05_03');
      expect(s.total_dwell_ms).toBe(12000);
      expect(s.object_count).toBe(3);
      expect(s.avg_dwell_ms).toBe(4000);
      expect(s.max_dwell_ms).toBe(6000);
      expect(s.min_dwell_ms).toBe(2000);
    });

    it('returns an empty array when no cell keys exist', async () => {
      mockRedis.keys.mockResolvedValue([]);
      const stats = await client.getCellStats('col-01', 'cam-01');
      expect(stats).toEqual([]);
    });

    it('skips keys whose sorted set is empty', async () => {
      mockRedis.keys.mockResolvedValue(['cell:col-01:cam-01:G_00_00']);
      mockRedis.zRangeWithScores.mockResolvedValue([]);

      const stats = await client.getCellStats('col-01', 'cam-01');
      expect(stats).toHaveLength(0);
    });

    it('sorts results descending by total_dwell_ms', async () => {
      mockRedis.keys.mockResolvedValue([
        'cell:col-01:cam-01:G_00_00',
        'cell:col-01:cam-01:G_01_01',
      ]);
      mockRedis.zRangeWithScores
        .mockResolvedValueOnce([{ value: 'obj-A', score: 1000 }])  // G_00_00
        .mockResolvedValueOnce([{ value: 'obj-B', score: 9000 }]); // G_01_01

      const stats = await client.getCellStats('col-01', 'cam-01');

      expect(stats[0].grid_cell_id).toBe('G_01_01');
      expect(stats[1].grid_cell_id).toBe('G_00_00');
    });

    it('queries only the requested cell when cell_id is provided', async () => {
      mockRedis.keys.mockResolvedValue(['cell:col-01:cam-01:G_05_03']);
      mockRedis.zRangeWithScores.mockResolvedValue([{ value: 'obj-A', score: 2000 }]);

      await client.getCellStats('col-01', 'cam-01', 'G_05_03');

      const keysPattern = mockRedis.keys.mock.calls[0][0];
      expect(keysPattern).toBe('cell:col-01:cam-01:G_05_03');
    });
  });

  // ---------------------------------------------------------------------------
  // setObjectState / getObjectState round-trip
  // ---------------------------------------------------------------------------

  describe('setObjectState / getObjectState', () => {
    it('writes all fields as strings and reads them back with correct types', async () => {
      const state = {
        collector_id: 'col-01',
        camera_id: 'cam-01',
        object_id: 'obj-A',
        current_cell: 'G_05_03',
        enter_ts_ms: 1000,
        last_seen_ts_ms: 2000,
        accumulated_ms: 500,
      };

      await client.setObjectState(state);

      const hSetArgs = mockRedis.hSet.mock.calls[0];
      expect(hSetArgs[1]).toMatchObject({
        current_cell: 'G_05_03',
        enter_ts_ms: '1000',
        last_seen_ts_ms: '2000',
        accumulated_ms: '500',
      });
    });

    it('stores null current_cell as the string "null"', async () => {
      await client.setObjectState({
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: null, enter_ts_ms: null, last_seen_ts_ms: 0, accumulated_ms: 0,
      });

      const hSetArgs = mockRedis.hSet.mock.calls[0][1];
      expect(hSetArgs.current_cell).toBe('null');
    });

    it('parses the stored hash back to typed ObjectState', async () => {
      mockRedis.hGetAll.mockResolvedValue({
        collector_id: 'col-01',
        camera_id: 'cam-01',
        object_id: 'obj-A',
        current_cell: 'G_05_03',
        enter_ts_ms: '1000',
        last_seen_ts_ms: '2000',
        accumulated_ms: '500',
      });

      const state = await client.getObjectState('col-01', 'cam-01', 'obj-A');

      expect(state).not.toBeNull();
      expect(state!.enter_ts_ms).toBe(1000);
      expect(state!.last_seen_ts_ms).toBe(2000);
      expect(state!.accumulated_ms).toBe(500);
      expect(state!.current_cell).toBe('G_05_03');
    });

    it('returns null when hGetAll returns an empty object (key not found)', async () => {
      mockRedis.hGetAll.mockResolvedValue({});
      const state = await client.getObjectState('col-01', 'cam-01', 'obj-X');
      expect(state).toBeNull();
    });

    it('converts the stored "null" string back to null for current_cell', async () => {
      mockRedis.hGetAll.mockResolvedValue({
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'null', enter_ts_ms: 'null',
        last_seen_ts_ms: '5000', accumulated_ms: '0',
      });

      const state = await client.getObjectState('col-01', 'cam-01', 'obj-A');
      expect(state!.current_cell).toBeNull();
      expect(state!.enter_ts_ms).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // addTimelineEntry / getTimeline round-trip
  // ---------------------------------------------------------------------------

  describe('addTimelineEntry / getTimeline', () => {
    it('pushes the JSON-serialised entry to the front of the list', async () => {
      const entry = { type: 'enter' as const, cell_id: 'G_05_03', from_ts_ms: 1000, to_ts_ms: null };
      await client.addTimelineEntry('col-01', 'cam-01', 'obj-A', entry);

      expect(mockRedis.lPush).toHaveBeenCalledOnce();
      const [key, value] = mockRedis.lPush.mock.calls[0];
      expect(key).toBe('timeline:col-01:cam-01:obj-A');
      expect(JSON.parse(value)).toMatchObject(entry);
    });

    it('trims the list to the latest 100 entries', async () => {
      await client.addTimelineEntry('col-01', 'cam-01', 'obj-A', {
        type: 'enter', cell_id: 'G_00_00', from_ts_ms: 0, to_ts_ms: null,
      });

      expect(mockRedis.lTrim).toHaveBeenCalledWith('timeline:col-01:cam-01:obj-A', 0, 99);
    });

    it('deserialises entries in reverse-chronological order', async () => {
      const entries = [
        { type: 'leave' as const, cell_id: 'G_00_00', from_ts_ms: 0, to_ts_ms: 3000 },
        { type: 'enter' as const, cell_id: 'G_01_01', from_ts_ms: 3000, to_ts_ms: null },
      ];
      mockRedis.lRange.mockResolvedValue(entries.map(e => JSON.stringify(e)));

      const result = await client.getTimeline('col-01', 'cam-01', 'obj-A');

      // Sorted descending by from_ts_ms
      expect(result[0].from_ts_ms).toBeGreaterThanOrEqual(result[1].from_ts_ms);
    });
  });

  // ---------------------------------------------------------------------------
  // getRecentEvents — Bug 3 fix: must read grid_cell_id, not grid_cell
  // ---------------------------------------------------------------------------

  describe('getRecentEvents', () => {
    it('maps grid_cell_id from the stored event to the grid_cell output field', async () => {
      const stored = {
        timestamp_ms: 1000,
        collector_id: 'col-01',
        camera_id: 'cam-01',
        object_id: 'obj-A',
        grid_cell_id: 'G_05_03',
        event_type: 'enter',
      };
      mockRedis.lRange.mockResolvedValue([JSON.stringify(stored)]);

      const events = await client.getRecentEvents(10);

      expect(events).toHaveLength(1);
      expect(events[0].grid_cell).toBe('G_05_03'); // populated from grid_cell_id
    });

    it('falls back to "unknown" when grid_cell_id is absent', async () => {
      const stored = { timestamp_ms: 1000, collector_id: 'c', camera_id: 'c', object_id: 'o' };
      mockRedis.lRange.mockResolvedValue([JSON.stringify(stored)]);

      const events = await client.getRecentEvents(10);
      expect(events[0].grid_cell).toBe('unknown');
    });

    it('returns an empty array when the list is empty', async () => {
      mockRedis.lRange.mockResolvedValue([]);
      const events = await client.getRecentEvents(10);
      expect(events).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // generateHeatmapData — parses G_XX_YY cell IDs into x/y coordinates
  // ---------------------------------------------------------------------------

  describe('generateHeatmapData', () => {
    it('parses G_XX_YY into numeric x and y coordinates', async () => {
      mockRedis.keys.mockResolvedValue(['cell:col-01:cam-01:G_05_03']);
      mockRedis.zRangeWithScores.mockResolvedValue([{ value: 'obj-A', score: 4000 }]);

      const heatmap = await client.generateHeatmapData('col-01', 'cam-01', 3600000);

      expect(heatmap.cells).toHaveLength(1);
      const cell = heatmap.cells[0];
      expect(cell.x).toBe(5);
      expect(cell.y).toBe(3);
      expect(cell.dwell_ms).toBe(4000);
      expect(cell.intensity).toBe(1); // only cell → max intensity
    });

    it('normalises intensity between 0 and 1 relative to max dwell', async () => {
      mockRedis.keys.mockResolvedValue([
        'cell:col-01:cam-01:G_00_00',
        'cell:col-01:cam-01:G_01_01',
      ]);
      mockRedis.zRangeWithScores
        .mockResolvedValueOnce([{ value: 'obj-A', score: 2000 }])
        .mockResolvedValueOnce([{ value: 'obj-B', score: 8000 }]);

      const heatmap = await client.generateHeatmapData('col-01', 'cam-01', 3600000);

      const cell00 = heatmap.cells.find(c => c.grid_cell_id === 'G_00_00')!;
      const cell11 = heatmap.cells.find(c => c.grid_cell_id === 'G_01_01')!;
      expect(cell11.intensity).toBe(1);
      expect(cell00.intensity).toBeCloseTo(0.25, 5);
    });

    it('returns empty cells for real-time mode (window_ms = 0)', async () => {
      const heatmap = await client.generateHeatmapData('col-01', 'cam-01', 0);
      expect(heatmap.cells).toHaveLength(0);
      expect(heatmap.window_ms).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // removeCellDwell
  // ---------------------------------------------------------------------------

  describe('removeCellDwell', () => {
    it('calls zRem with the correct key and objectId', async () => {
      await client.removeCellDwell('col-01', 'cam-01', 'G_05_03', 'obj-A');

      expect(mockRedis.zRem).toHaveBeenCalledWith('cell:col-01:cam-01:G_05_03', 'obj-A');
    });
  });
});
