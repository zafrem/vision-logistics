import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import pino from 'pino';
import type { ObjectState, TimelineEntry, CellStats, HeatmapData } from '../types/index.js';

const logger = pino({ name: 'redis-client' });

export class RedisClient {
  private client: RedisClientType;
  private isConnected = false;

  constructor(url: string = 'redis://localhost:6379') {
    this.client = createClient({ url });

    this.client.on('error', (err) => {
      logger.error({ error: err }, 'Redis client error');
    });

    this.client.on('connect', () => {
      logger.info('Redis client connected');
    });

    this.client.on('ready', () => {
      logger.info('Redis client ready');
      this.isConnected = true;
    });

    this.client.on('end', () => {
      logger.info('Redis client connection ended');
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.client.quit();
  }

  private getObjectStateKey(collectorId: string, cameraId: string, objectId: string): string {
    return `obj:${collectorId}:${cameraId}:${objectId}`;
  }

  private getCellKey(collectorId: string, cameraId: string, cellId: string): string {
    return `cell:${collectorId}:${cameraId}:${cellId}`;
  }

  private getTimelineKey(collectorId: string, cameraId: string, objectId: string): string {
    return `timeline:${collectorId}:${cameraId}:${objectId}`;
  }

  async getObjectState(collectorId: string, cameraId: string, objectId: string): Promise<ObjectState | null> {
    const key = this.getObjectStateKey(collectorId, cameraId, objectId);
    const data = await this.client.hGetAll(key);
    
    if (Object.keys(data).length === 0) return null;

    return {
      collector_id: data.collector_id,
      camera_id: data.camera_id,
      object_id: data.object_id,
      current_cell: data.current_cell === 'null' ? null : data.current_cell,
      enter_ts_ms: data.enter_ts_ms && data.enter_ts_ms !== 'null' ? parseInt(data.enter_ts_ms) : null,
      last_seen_ts_ms: parseInt(data.last_seen_ts_ms),
      accumulated_ms: parseInt(data.accumulated_ms),
    };
  }

  async setObjectState(state: ObjectState): Promise<void> {
    const key = this.getObjectStateKey(state.collector_id, state.camera_id, state.object_id);
    
    await this.client.hSet(key, {
      collector_id: state.collector_id,
      camera_id: state.camera_id,
      object_id: state.object_id,
      current_cell: state.current_cell ?? 'null',
      enter_ts_ms: state.enter_ts_ms?.toString() ?? 'null',
      last_seen_ts_ms: state.last_seen_ts_ms.toString(),
      accumulated_ms: state.accumulated_ms.toString(),
    });

    await this.client.expire(key, 86400);
  }

  async updateCellDwell(collectorId: string, cameraId: string, cellId: string, objectId: string, dwellMs: number): Promise<void> {
    const key = this.getCellKey(collectorId, cameraId, cellId);
    await this.client.zIncrBy(key, dwellMs, objectId);
    await this.client.expire(key, 86400);
  }

  async removeCellDwell(collectorId: string, cameraId: string, cellId: string, objectId: string): Promise<void> {
    const key = this.getCellKey(collectorId, cameraId, cellId);
    await this.client.zRem(key, objectId);
  }

  async getCellStats(collectorId: string, cameraId: string, cellId?: string): Promise<CellStats[]> {
    const pattern = cellId
      ? this.getCellKey(collectorId, cameraId, cellId)
      : `cell:${collectorId}:${cameraId}:*`;

    const keys = await this.client.keys(pattern);
    const stats: CellStats[] = [];

    for (const key of keys) {
      const cellIdFromKey = key.split(':').slice(3).join(':');
      const members: Array<{ value: string; score: number }> = await this.client.zRangeWithScores(key, 0, -1);

      if (members.length === 0) continue;

      const dwellValues = members.map(m => m.score);
      const totalDwell = dwellValues.reduce((sum, d) => sum + d, 0);
      const objectCount = members.length;

      stats.push({
        collector_id: collectorId,
        camera_id: cameraId,
        grid_cell_id: cellIdFromKey,
        total_dwell_ms: Math.floor(totalDwell),
        object_count: objectCount,
        avg_dwell_ms: Math.floor(totalDwell / objectCount),
        max_dwell_ms: Math.floor(Math.max(...dwellValues)),
        min_dwell_ms: Math.floor(Math.min(...dwellValues)),
      });
    }

    return stats.sort((a, b) => b.total_dwell_ms - a.total_dwell_ms);
  }

  async addTimelineEntry(collectorId: string, cameraId: string, objectId: string, entry: TimelineEntry): Promise<void> {
    const key = this.getTimelineKey(collectorId, cameraId, objectId);
    await this.client.lPush(key, JSON.stringify(entry));
    await this.client.lTrim(key, 0, 99);
    await this.client.expire(key, 86400);
  }

  async getTimeline(collectorId: string, cameraId: string, objectId: string): Promise<TimelineEntry[]> {
    const key = this.getTimelineKey(collectorId, cameraId, objectId);
    const entries = await this.client.lRange(key, 0, -1);
    
    return entries.map(entry => JSON.parse(entry) as TimelineEntry)
      .sort((a, b) => b.from_ts_ms - a.from_ts_ms);
  }

  async generateHeatmapData(
    collectorId: string, 
    cameraId: string, 
    windowMs: number = 3600000
  ): Promise<HeatmapData> {
    const now = Date.now();
    
    // For real-time mode (windowMs = 0), return empty historical data
    if (windowMs === 0) {
      return {
        collector_id: collectorId,
        camera_id: cameraId,
        grid_size: { width: 20, height: 15 },
        cells: [],
        timestamp: now,
        window_ms: windowMs,
      };
    }
    
    const stats = await this.getCellStats(collectorId, cameraId);
    const maxDwell = stats.length > 0 ? Math.max(...stats.map(s => s.total_dwell_ms)) : 1;
    
    const cells = stats.map(stat => {
      const [, gridX, gridY] = stat.grid_cell_id.match(/G_(\d+)_(\d+)/) || ['', '0', '0'];
      
      return {
        grid_cell_id: stat.grid_cell_id,
        x: parseInt(gridX),
        y: parseInt(gridY),
        dwell_ms: stat.total_dwell_ms,
        object_count: stat.object_count,
        intensity: stat.total_dwell_ms / maxDwell,
      };
    });

    return {
      collector_id: collectorId,
      camera_id: cameraId,
      grid_size: { width: 20, height: 15 },
      cells,
      timestamp: now,
      window_ms: windowMs,
    };
  }

  async logFeedbackEvent(eventType: string, data: unknown): Promise<void> {
    await this.client.xAdd('audit:feedback', '*', {
      event_type: eventType,
      timestamp: Date.now().toString(),
      data: JSON.stringify(data),
    });
  }

  async addRecentEvent(event: any): Promise<void> {
    try {
      await this.client.lPush('recent:events', JSON.stringify(event));
      await this.client.lTrim('recent:events', 0, 99); // Keep last 100 events
    } catch (error) {
      logger.error({ error }, 'Failed to add recent event');
    }
  }

  async getRecentEvents(limit: number = 50): Promise<any[]> {
    try {
      // Get recent events from a simple list  
      const events = await this.client.lRange('recent:events', 0, limit - 1);
      
      return events.map(eventStr => {
        try {
          const event = JSON.parse(eventStr);
          return {
            id: `${event.timestamp_ms}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: event.timestamp_ms,
            collector_id: event.collector_id,
            camera_id: event.camera_id,
            object_id: event.object_id,
            grid_cell: event.grid_cell_id || 'unknown',
            event_type: event.event_type,
            timestamp_ms: event.timestamp_ms.toString()
          };
        } catch (parseError) {
          logger.error({ parseError, eventStr }, 'Failed to parse event');
          return null;
        }
      }).filter(event => event !== null);
    } catch (error) {
      logger.error({ error }, 'Failed to get recent events');
      return [];
    }
  }

  async getActiveObjects(collectorId: string, cameraId: string): Promise<ObjectState[]> {
    try {
      const pattern = `obj:${collectorId}:${cameraId}:*`;
      const keys = await this.client.keys(pattern);
      
      if (keys.length === 0) {
        return [];
      }

      const objectStates = await Promise.all(
        keys.map(async (key) => {
          const data = await this.client.hGetAll(key);
          if (Object.keys(data).length === 0) return null;
          
          const state: ObjectState = {
            collector_id: data.collector_id || collectorId,
            camera_id: data.camera_id || cameraId,
            object_id: data.object_id,
            current_cell: data.current_cell || null,
            enter_ts_ms: data.enter_ts_ms && data.enter_ts_ms !== 'null' ? parseInt(data.enter_ts_ms) : null,
            last_seen_ts_ms: parseInt(data.last_seen_ts_ms),
            accumulated_ms: parseInt(data.accumulated_ms || '0'),
          };

          // Only return objects that are currently in a cell (active)
          return state.current_cell ? state : null;
        })
      );

      return objectStates.filter(state => state !== null) as ObjectState[];
    } catch (error) {
      logger.error({ error, collectorId, cameraId }, 'Failed to get active objects');
      return [];
    }
  }
}