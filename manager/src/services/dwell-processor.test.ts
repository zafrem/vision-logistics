import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DwellProcessor } from './dwell-processor.js';
import type { ObjectState } from '../types/index.js';

function makeRedisClientMock() {
  return {
    getObjectState: vi.fn<() => Promise<ObjectState | null>>().mockResolvedValue(null),
    setObjectState: vi.fn().mockResolvedValue(undefined),
    updateCellDwell: vi.fn().mockResolvedValue(undefined),
    addTimelineEntry: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEvent(overrides: Partial<{
  event_id: string;
  collector_id: string;
  camera_id: string;
  object_id: string;
  grid_cell_id: string;
  ts_ms: number;
}> = {}) {
  return {
    event_id: 'evt-001',
    collector_id: 'col-01',
    camera_id: 'cam-01',
    object_id: 'obj-A',
    grid_cell_id: 'G_05_03',
    ts_ms: 1000,
    ...overrides,
  };
}

describe('DwellProcessor', () => {
  let redis: ReturnType<typeof makeRedisClientMock>;
  let processor: DwellProcessor;
  const TIMEOUT_MS = 30_000;

  beforeEach(() => {
    redis = makeRedisClientMock();
    processor = new DwellProcessor(redis as any, TIMEOUT_MS);
  });

  // ---------------------------------------------------------------------------
  // First-ever event for an object
  // ---------------------------------------------------------------------------

  describe('first event for a new object', () => {
    it('saves a new ObjectState with current_cell and enter_ts_ms', async () => {
      const event = makeEvent({ ts_ms: 5000 });
      await processor.processEvent(event);

      expect(redis.setObjectState).toHaveBeenCalledOnce();
      const saved: ObjectState = redis.setObjectState.mock.calls[0][0];
      expect(saved.collector_id).toBe('col-01');
      expect(saved.camera_id).toBe('cam-01');
      expect(saved.object_id).toBe('obj-A');
      expect(saved.current_cell).toBe('G_05_03');
      expect(saved.enter_ts_ms).toBe(5000);
      expect(saved.last_seen_ts_ms).toBe(5000);
      expect(saved.accumulated_ms).toBe(0);
    });

    it('records an enter timeline entry', async () => {
      const event = makeEvent({ ts_ms: 5000 });
      await processor.processEvent(event);

      expect(redis.addTimelineEntry).toHaveBeenCalledOnce();
      const entry = redis.addTimelineEntry.mock.calls[0][3];
      expect(entry.type).toBe('enter');
      expect(entry.cell_id).toBe('G_05_03');
      expect(entry.from_ts_ms).toBe(5000);
      expect(entry.to_ts_ms).toBeNull();
    });

    it('does not call updateCellDwell for the first event', async () => {
      await processor.processEvent(makeEvent());
      expect(redis.updateCellDwell).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Same-cell update (object stays in place)
  // ---------------------------------------------------------------------------

  describe('same-cell update', () => {
    it('only advances last_seen_ts_ms; enter_ts_ms and cell are unchanged', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 1000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      await processor.processEvent(makeEvent({ ts_ms: 2000 }));

      const saved: ObjectState = redis.setObjectState.mock.calls[0][0];
      expect(saved.last_seen_ts_ms).toBe(2000);
      expect(saved.enter_ts_ms).toBe(1000); // unchanged
      expect(saved.current_cell).toBe('G_05_03'); // unchanged
      expect(saved.accumulated_ms).toBe(0); // unchanged
    });

    it('does not call updateCellDwell or add a timeline entry', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 1000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      await processor.processEvent(makeEvent({ ts_ms: 2000 }));

      expect(redis.updateCellDwell).not.toHaveBeenCalled();
      expect(redis.addTimelineEntry).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Cell transition
  // ---------------------------------------------------------------------------

  describe('cell transition', () => {
    it('records dwell time in the old cell', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 1000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      await processor.processEvent(makeEvent({ grid_cell_id: 'G_10_07', ts_ms: 6000 }));

      expect(redis.updateCellDwell).toHaveBeenCalledOnce();
      const [, , cellId, , dwellMs] = redis.updateCellDwell.mock.calls[0];
      expect(cellId).toBe('G_05_03');
      expect(dwellMs).toBe(5000); // 6000 - 1000
    });

    it('accumulates dwell in the new ObjectState', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 1000, accumulated_ms: 2000,
      };
      redis.getObjectState.mockResolvedValue(existing);

      await processor.processEvent(makeEvent({ grid_cell_id: 'G_10_07', ts_ms: 6000 }));

      const saved: ObjectState = redis.setObjectState.mock.calls[0][0];
      expect(saved.accumulated_ms).toBe(7000); // 2000 existing + 5000 dwell
      expect(saved.current_cell).toBe('G_10_07');
      expect(saved.enter_ts_ms).toBe(6000);
    });

    it('adds a leave entry for the old cell and an enter entry for the new cell', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 1000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      await processor.processEvent(makeEvent({ grid_cell_id: 'G_10_07', ts_ms: 6000 }));

      expect(redis.addTimelineEntry).toHaveBeenCalledTimes(2);
      const [leaveEntry, enterEntry] = redis.addTimelineEntry.mock.calls.map(c => c[3]);
      expect(leaveEntry.type).toBe('leave');
      expect(leaveEntry.cell_id).toBe('G_05_03');
      expect(leaveEntry.from_ts_ms).toBe(1000);
      expect(leaveEntry.to_ts_ms).toBe(6000);
      expect(enterEntry.type).toBe('enter');
      expect(enterEntry.cell_id).toBe('G_10_07');
      expect(enterEntry.from_ts_ms).toBe(6000);
      expect(enterEntry.to_ts_ms).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Accumulated dwell across multiple transitions
  // ---------------------------------------------------------------------------

  describe('accumulated dwell across multiple transitions', () => {
    it('sums dwell from each cell visit into accumulated_ms', async () => {
      // Simulate: cell A 0→3000, cell B 3000→8000, cell A 8000→10000
      const stateInA: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_00_00', enter_ts_ms: 0, last_seen_ts_ms: 0, accumulated_ms: 0,
      };
      const stateInB: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_01_01', enter_ts_ms: 3000, last_seen_ts_ms: 3000, accumulated_ms: 3000,
      };

      redis.getObjectState
        .mockResolvedValueOnce(stateInA)  // A → B transition
        .mockResolvedValueOnce(stateInB); // B → A transition

      await processor.processEvent(makeEvent({ grid_cell_id: 'G_01_01', ts_ms: 3000 }));
      await processor.processEvent(makeEvent({ event_id: 'evt-002', grid_cell_id: 'G_00_00', ts_ms: 8000 }));

      const lastSave: ObjectState = redis.setObjectState.mock.calls[1][0];
      expect(lastSave.accumulated_ms).toBe(8000); // 3000 (A) + 5000 (B)
    });
  });

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  describe('event deduplication', () => {
    it('silently skips an event with a previously processed event_id', async () => {
      const event = makeEvent();
      await processor.processEvent(event);
      vi.clearAllMocks();

      await processor.processEvent(event); // same event_id

      expect(redis.getObjectState).not.toHaveBeenCalled();
      expect(redis.setObjectState).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout handling
  // ---------------------------------------------------------------------------

  describe('timeout', () => {
    it('calls updateCellDwell for the timed-out cell before creating a new entry', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 2000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      const afterTimeout = 2000 + TIMEOUT_MS + 1;
      await processor.processEvent(makeEvent({ grid_cell_id: 'G_10_07', ts_ms: afterTimeout }));

      expect(redis.updateCellDwell).toHaveBeenCalledOnce();
      const [, , cellId, , dwellMs] = redis.updateCellDwell.mock.calls[0];
      expect(cellId).toBe('G_05_03');
      expect(dwellMs).toBe(1000); // last_seen_ts_ms(2000) - enter_ts_ms(1000)
    });

    it('treats the post-timeout re-entry as a fresh enter, resetting enter_ts_ms', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 2000, accumulated_ms: 500,
      };
      redis.getObjectState.mockResolvedValue(existing);

      const afterTimeout = 2000 + TIMEOUT_MS + 1;
      await processor.processEvent(makeEvent({ grid_cell_id: 'G_10_07', ts_ms: afterTimeout }));

      const saved: ObjectState = redis.setObjectState.mock.calls[0][0];
      expect(saved.current_cell).toBe('G_10_07');
      expect(saved.enter_ts_ms).toBe(afterTimeout); // reset, NOT 1000
      expect(saved.last_seen_ts_ms).toBe(afterTimeout);
      expect(saved.accumulated_ms).toBe(500); // preserved from before timeout
    });

    it('resets enter_ts_ms even when object re-enters the SAME cell after timeout (Bug 4)', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 2000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      const afterTimeout = 2000 + TIMEOUT_MS + 1;
      // Same cell as the existing state
      await processor.processEvent(makeEvent({ grid_cell_id: 'G_05_03', ts_ms: afterTimeout }));

      const saved: ObjectState = redis.setObjectState.mock.calls[0][0];
      expect(saved.current_cell).toBe('G_05_03');
      expect(saved.enter_ts_ms).toBe(afterTimeout); // must be reset
    });

    it('adds a leave entry for the timed-out cell and an enter entry for the new cell', async () => {
      const existing: ObjectState = {
        collector_id: 'col-01', camera_id: 'cam-01', object_id: 'obj-A',
        current_cell: 'G_05_03', enter_ts_ms: 1000, last_seen_ts_ms: 2000, accumulated_ms: 0,
      };
      redis.getObjectState.mockResolvedValue(existing);

      const afterTimeout = 2000 + TIMEOUT_MS + 1;
      await processor.processEvent(makeEvent({ grid_cell_id: 'G_10_07', ts_ms: afterTimeout }));

      const entries = redis.addTimelineEntry.mock.calls.map(c => c[3]);
      const leave = entries.find(e => e.type === 'leave');
      const enter = entries.find(e => e.type === 'enter');

      expect(leave).toBeDefined();
      expect(leave!.cell_id).toBe('G_05_03');
      expect(leave!.meta).toMatchObject({ reason: 'timeout' });

      expect(enter).toBeDefined();
      expect(enter!.cell_id).toBe('G_10_07');
      expect(enter!.from_ts_ms).toBe(afterTimeout);
    });
  });
});
