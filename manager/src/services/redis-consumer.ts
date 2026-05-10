import { createClient } from 'redis';
import pino from 'pino';
import { DwellProcessor } from './dwell-processor.js';
import { RedisClient } from './redis-client.js';
import type { NormalizedEvent } from '../types/index.js';

const logger = pino({ name: 'redis-consumer' });

export class RedisConsumer {
  private client: any;
  private dwellProcessor: DwellProcessor;
  private redisClient: RedisClient;
  private isRunning = false;
  private processingInterval?: NodeJS.Timeout;

  constructor(dwellProcessor: DwellProcessor, redisClient: RedisClient, redisUrl: string = 'redis://localhost:6379') {
    this.dwellProcessor = dwellProcessor;
    this.redisClient = redisClient;
    this.client = createClient({ url: redisUrl });
    
    this.client.on('error', (err) => {
      logger.error({ error: err }, 'Redis consumer client error');
    });

    this.client.on('connect', () => {
      logger.info('Redis consumer client connected');
    });

    this.client.on('ready', () => {
      logger.info('Redis consumer client ready');
    });
  }

  async start(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }

    this.isRunning = true;
    
    // Start processing detection queue every 100ms
    this.processingInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.processDetectionQueue();
      }
    }, 100);

    logger.info('Redis consumer started');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    if (this.client.isOpen) {
      await this.client.disconnect();
    }

    logger.info('Redis consumer stopped');
  }

  private async processDetectionQueue(): Promise<void> {
    try {
      // Get oldest events from the sorted set (FIFO processing)
      const results = await this.client.zRange('detection:queue', 0, 9);
      
      if (results.length === 0) {
        return;
      }

      // Remove the processed items from queue
      if (results.length > 0) {
        await this.client.zRem('detection:queue', results);
      }

      const events: NormalizedEvent[] = results.map(result => 
        JSON.parse(result) as NormalizedEvent
      );

      // Process events through dwell processor
      for (const event of events) {
        await this.dwellProcessor.processEvent(event);
        
        // Also add to recent events list for real-time log
        try {
          await this.redisClient.addRecentEvent(event);
        } catch (logError) {
          logger.error({ logError }, 'Failed to add event to recent events log');
        }
      }

      logger.debug({ eventCount: events.length }, 'Processed detection events from Redis queue');
    } catch (error) {
      logger.error({ error }, 'Failed to process detection queue');
    }
  }

  getConsumerState(): any {
    return {
      connected: this.client.isOpen,
      running: this.isRunning,
      type: 'redis'
    };
  }
}