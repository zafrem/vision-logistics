import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the raw 'redis' client used internally by RedisConsumer for queue reads
// ---------------------------------------------------------------------------
const mockQueueClient = {
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isOpen: true,
  zRange: vi.fn().mockResolvedValue([]),
  zRem: vi.fn().mockResolvedValue(0),
};

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockQueueClient),
}));

import { RedisConsumer } from './redis-consumer.js';

function makeDwellProcessorMock() {
  return { processEvent: vi.fn().mockResolvedValue(undefined) };
}

function makeRedisClientMock() {
  return { addRecentEvent: vi.fn().mockResolvedValue(undefined) };
}

function makeEvent(overrides = {}) {
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

describe('RedisConsumer', () => {
  let dwellProcessor: ReturnType<typeof makeDwellProcessorMock>;
  let redisClient: ReturnType<typeof makeRedisClientMock>;
  let consumer: RedisConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueClient.zRange.mockResolvedValue([]);
    dwellProcessor = makeDwellProcessorMock();
    redisClient = makeRedisClientMock();
    consumer = new RedisConsumer(dwellProcessor as any, redisClient as any);
  });

  // ---------------------------------------------------------------------------
  // processDetectionQueue (exercised via the private method directly)
  // ---------------------------------------------------------------------------

  describe('processDetectionQueue', () => {
    it('calls processEvent (not processDetectionEvent) for each queued event — Bug 1 regression', async () => {
      const event = makeEvent();
      mockQueueClient.zRange.mockResolvedValueOnce([JSON.stringify(event)]);

      await (consumer as any).processDetectionQueue();

      // Must have been called with the parsed event object
      expect(dwellProcessor.processEvent).toHaveBeenCalledOnce();
      expect(dwellProcessor.processEvent).toHaveBeenCalledWith(event);
    });

    it('processes multiple events from a single queue poll', async () => {
      const events = [makeEvent(), makeEvent({ event_id: 'evt-002', object_id: 'obj-B' })];
      mockQueueClient.zRange.mockResolvedValueOnce(events.map(e => JSON.stringify(e)));

      await (consumer as any).processDetectionQueue();

      expect(dwellProcessor.processEvent).toHaveBeenCalledTimes(2);
    });

    it('calls addRecentEvent for each processed event', async () => {
      const event = makeEvent();
      mockQueueClient.zRange.mockResolvedValueOnce([JSON.stringify(event)]);

      await (consumer as any).processDetectionQueue();

      expect(redisClient.addRecentEvent).toHaveBeenCalledOnce();
      expect(redisClient.addRecentEvent).toHaveBeenCalledWith(event);
    });

    it('removes processed events from the queue', async () => {
      const raw = JSON.stringify(makeEvent());
      mockQueueClient.zRange.mockResolvedValueOnce([raw]);

      await (consumer as any).processDetectionQueue();

      expect(mockQueueClient.zRem).toHaveBeenCalledWith('detection:queue', [raw]);
    });

    it('does nothing when the queue is empty', async () => {
      mockQueueClient.zRange.mockResolvedValueOnce([]);

      await (consumer as any).processDetectionQueue();

      expect(dwellProcessor.processEvent).not.toHaveBeenCalled();
      expect(mockQueueClient.zRem).not.toHaveBeenCalled();
    });

    it('does not propagate errors thrown during queue processing', async () => {
      mockQueueClient.zRange.mockRejectedValueOnce(new Error('Redis down'));

      // Should resolve, not reject
      await expect((consumer as any).processDetectionQueue()).resolves.toBeUndefined();
    });

    it('reads from the correct sorted-set key', async () => {
      await (consumer as any).processDetectionQueue();

      expect(mockQueueClient.zRange).toHaveBeenCalledWith('detection:queue', 0, 9);
    });
  });

  // ---------------------------------------------------------------------------
  // getConsumerState
  // ---------------------------------------------------------------------------

  describe('getConsumerState', () => {
    it('reports connected=true when the internal client isOpen', () => {
      const state = consumer.getConsumerState();
      expect(state.connected).toBe(true);
    });

    it('reports running=false before start() is called', () => {
      const state = consumer.getConsumerState();
      expect(state.running).toBe(false);
    });
  });
});
