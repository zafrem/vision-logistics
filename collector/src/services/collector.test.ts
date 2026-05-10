import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CollectorService } from './collector.js';

// Build a lightweight mock for RedisPublisher injected via constructor
function makePublisherMock() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    publishDetectionEvents: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CollectorService', () => {
  let service: CollectorService;
  let publisher: ReturnType<typeof makePublisherMock>;

  beforeEach(() => {
    publisher = makePublisherMock();
    // Cast is safe: tests only exercise the public API which maps 1-to-1
    service = new CollectorService('test-collector', publisher as any);
  });

  afterEach(async () => {
    // Guard: stop the service if a test left it running
    try { await service.stop(); } catch { /* already stopped */ }
  });

  // ---------------------------------------------------------------------------
  // generateTestFrame
  // ---------------------------------------------------------------------------

  describe('generateTestFrame', () => {
    it('returns a CameraFrame with the requested camera_id', () => {
      const frame = service.generateTestFrame('cam-001', 3);
      expect(frame.camera_id).toBe('cam-001');
    });

    it('returns the requested number of objects', () => {
      expect(service.generateTestFrame('cam-001', 0).objects).toHaveLength(0);
      expect(service.generateTestFrame('cam-001', 5).objects).toHaveLength(5);
    });

    it('includes a positive timestamp_ms', () => {
      const before = Date.now();
      const frame = service.generateTestFrame('cam-001', 1);
      expect(frame.timestamp_ms).toBeGreaterThanOrEqual(before);
    });

    it('encodes frame_id as <camera_id>-<timestamp>', () => {
      const frame = service.generateTestFrame('cam-001', 1);
      expect(frame.frame_id).toMatch(/^cam-001-\d+$/);
    });

    it('generates grid_cell_id in G_XX_YY format within grid bounds', () => {
      const frame = service.generateTestFrame('cam-001', 20);
      for (const obj of frame.objects) {
        expect(obj.grid_cell_id).toMatch(/^G_\d{2}_\d{2}$/);
        const [, xStr, yStr] = obj.grid_cell_id.match(/G_(\d{2})_(\d{2})/)!;
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(20);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(15);
      }
    });

    it('generates confidence in [0.7, 1.0]', () => {
      const frame = service.generateTestFrame('cam-001', 10);
      for (const obj of frame.objects) {
        expect(obj.confidence).toBeGreaterThanOrEqual(0.7);
        expect(obj.confidence).toBeLessThanOrEqual(1.0);
      }
    });

    it('generates a 4-element numeric bbox per object', () => {
      const frame = service.generateTestFrame('cam-001', 5);
      for (const obj of frame.objects) {
        expect(obj.bbox).toHaveLength(4);
        expect(obj.bbox.every(v => typeof v === 'number')).toBe(true);
      }
    });

    it('assigns a recognised object class to each object', () => {
      const knownClasses = ['pallet', 'forklift', 'worker', 'box', 'container', 'truck'];
      const frame = service.generateTestFrame('cam-001', 10);
      for (const obj of frame.objects) {
        expect(knownClasses).toContain(obj.class);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // processCameraFrame
  // ---------------------------------------------------------------------------

  describe('processCameraFrame', () => {
    it('throws when the service has not been started', async () => {
      const frame = service.generateTestFrame('cam-001', 1);
      await expect(service.processCameraFrame(frame)).rejects.toThrow('Collector service not started');
    });

    it('publishes one batch of normalized events when started', async () => {
      await service.start();
      const frame = service.generateTestFrame('cam-001', 3);
      await service.processCameraFrame(frame);

      expect(publisher.publishDetectionEvents).toHaveBeenCalledOnce();
      const events = publisher.publishDetectionEvents.mock.calls[0][0];
      expect(events).toHaveLength(3);
    });

    it('does not call publishDetectionEvents for a frame with no objects', async () => {
      await service.start();
      await service.processCameraFrame({
        camera_id: 'cam-001',
        frame_id: 'empty-frame',
        timestamp_ms: Date.now(),
        objects: [],
      });
      expect(publisher.publishDetectionEvents).not.toHaveBeenCalled();
    });

    it('builds normalized events with the correct field values', async () => {
      await service.start();
      const frame = service.generateTestFrame('cam-001', 1);
      await service.processCameraFrame(frame);

      const events = publisher.publishDetectionEvents.mock.calls[0][0];
      const event = events[0];

      expect(event.collector_id).toBe('test-collector');
      expect(event.camera_id).toBe('cam-001');
      expect(event.ts_ms).toBe(frame.timestamp_ms);
      expect(event.object_id).toBe(frame.objects[0].object_id);
      expect(event.grid_cell_id).toBe(frame.objects[0].grid_cell_id);
    });

    it('formats event_id as evt-<collectorId>-<cameraId>-<ts>-<objectId>', async () => {
      await service.start();
      const frame = service.generateTestFrame('cam-001', 1);
      await service.processCameraFrame(frame);

      const event = publisher.publishDetectionEvents.mock.calls[0][0][0];
      const expectedPrefix = `evt-test-collector-cam-001-${frame.timestamp_ms}-`;
      expect(event.event_id).toMatch(new RegExp(`^${expectedPrefix}`));
    });
  });

  // ---------------------------------------------------------------------------
  // processMultipleFrames
  // ---------------------------------------------------------------------------

  describe('processMultipleFrames', () => {
    it('processes all frames in the list', async () => {
      await service.start();
      const frames = Array.from({ length: 12 }, (_, i) =>
        service.generateTestFrame(`cam-${String(i).padStart(3, '0')}`, 2)
      );

      await service.processMultipleFrames(frames);

      // One publishDetectionEvents call per frame (each has 2 objects)
      expect(publisher.publishDetectionEvents).toHaveBeenCalledTimes(12);
    });

    it('processes frames in batches of 10', async () => {
      await service.start();
      // 11 frames → 2 batches; each batch resolved before the next
      const frames = Array.from({ length: 11 }, (_, i) =>
        service.generateTestFrame(`cam-${String(i).padStart(3, '0')}`, 1)
      );

      await service.processMultipleFrames(frames);
      expect(publisher.publishDetectionEvents).toHaveBeenCalledTimes(11);
    });
  });
});
