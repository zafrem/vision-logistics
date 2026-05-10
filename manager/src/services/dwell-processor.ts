import pino from 'pino';
import type { NormalizedEvent, ObjectState, TimelineEntry } from '../types/index.js';
import { RedisClient } from './redis-client.js';

const logger = pino({ name: 'dwell-processor' });

export class DwellProcessor {
  private redisClient: RedisClient;
  private processedEvents = new Set<string>();
  private timeoutMs: number;

  constructor(redisClient: RedisClient, timeoutMs: number = 30000) {
    this.redisClient = redisClient;
    this.timeoutMs = timeoutMs;
  }

  async processEvent(event: NormalizedEvent): Promise<void> {
    if (this.processedEvents.has(event.event_id)) {
      logger.debug({ eventId: event.event_id }, 'Event already processed, skipping');
      return;
    }

    try {
      const currentState = await this.redisClient.getObjectState(
        event.collector_id,
        event.camera_id,
        event.object_id
      );

      const newState = await this.updateDwellState(event, currentState);
      await this.redisClient.setObjectState(newState);

      this.processedEvents.add(event.event_id);
      
      if (this.processedEvents.size > 10000) {
        this.processedEvents.clear();
      }

      logger.debug({
        eventId: event.event_id,
        objectId: event.object_id,
        cellId: event.grid_cell_id,
        currentCell: currentState?.current_cell,
        newCell: newState.current_cell
      }, 'Processed dwell event');

    } catch (error) {
      logger.error({ error, event }, 'Failed to process dwell event');
      throw error;
    }
  }

  private async updateDwellState(event: NormalizedEvent, currentState: ObjectState | null): Promise<ObjectState> {
    const now = event.ts_ms;

    if (!currentState) {
      const newState: ObjectState = {
        collector_id: event.collector_id,
        camera_id: event.camera_id,
        object_id: event.object_id,
        current_cell: event.grid_cell_id,
        enter_ts_ms: now,
        last_seen_ts_ms: now,
        accumulated_ms: 0,
      };

      await this.addTimelineEntry(event, {
        type: 'enter',
        cell_id: event.grid_cell_id,
        from_ts_ms: now,
        to_ts_ms: null,
      });

      return newState;
    }

    const timeSinceLastSeen = now - currentState.last_seen_ts_ms;

    if (timeSinceLastSeen > this.timeoutMs) {
      await this.handleTimeout(currentState, now);

      // After a timeout the object is treated as re-entering fresh, regardless of cell
      await this.addTimelineEntry(event, {
        type: 'enter',
        cell_id: event.grid_cell_id,
        from_ts_ms: now,
        to_ts_ms: null,
      });

      return {
        collector_id: event.collector_id,
        camera_id: event.camera_id,
        object_id: event.object_id,
        current_cell: event.grid_cell_id,
        enter_ts_ms: now,
        last_seen_ts_ms: now,
        accumulated_ms: currentState.accumulated_ms,
      };
    }

    if (currentState.current_cell === event.grid_cell_id) {
      return {
        ...currentState,
        last_seen_ts_ms: now,
      };
    }

    const dwellTime = currentState.enter_ts_ms ? now - currentState.enter_ts_ms : 0;
    const newAccumulated = currentState.accumulated_ms + dwellTime;

    if (currentState.current_cell && currentState.enter_ts_ms) {
      await this.redisClient.updateCellDwell(
        event.collector_id,
        event.camera_id,
        currentState.current_cell,
        event.object_id,
        dwellTime
      );

      await this.addTimelineEntry(event, {
        type: 'leave',
        cell_id: currentState.current_cell,
        from_ts_ms: currentState.enter_ts_ms,
        to_ts_ms: now,
      });
    }

    await this.addTimelineEntry(event, {
      type: 'enter',
      cell_id: event.grid_cell_id,
      from_ts_ms: now,
      to_ts_ms: null,
    });

    return {
      collector_id: event.collector_id,
      camera_id: event.camera_id,
      object_id: event.object_id,
      current_cell: event.grid_cell_id,
      enter_ts_ms: now,
      last_seen_ts_ms: now,
      accumulated_ms: newAccumulated,
    };
  }

  private async handleTimeout(state: ObjectState, currentTime: number): Promise<void> {
    if (state.current_cell && state.enter_ts_ms) {
      const dwellTime = state.last_seen_ts_ms - state.enter_ts_ms;
      
      await this.redisClient.updateCellDwell(
        state.collector_id,
        state.camera_id,
        state.current_cell,
        state.object_id,
        dwellTime
      );

      await this.redisClient.addTimelineEntry(
        state.collector_id,
        state.camera_id,
        state.object_id,
        {
          type: 'leave',
          cell_id: state.current_cell,
          from_ts_ms: state.enter_ts_ms,
          to_ts_ms: state.last_seen_ts_ms,
          meta: { reason: 'timeout' },
        }
      );

      logger.info({
        objectId: state.object_id,
        cellId: state.current_cell,
        dwellTime,
        reason: 'timeout'
      }, 'Object timed out from cell');
    }
  }

  private async addTimelineEntry(event: NormalizedEvent, entry: TimelineEntry): Promise<void> {
    await this.redisClient.addTimelineEntry(
      event.collector_id,
      event.camera_id,
      event.object_id,
      entry
    );
  }

  async processTimeouts(): Promise<void> {
    const now = Date.now();
    
    logger.debug('Processing timeouts for stale objects');
  }
}