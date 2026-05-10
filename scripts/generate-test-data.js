#!/usr/bin/env node

import { randomUUID } from 'crypto';
import axios from 'axios';

const COLLECTOR_BASE_URL = process.env.COLLECTOR_URL || 'http://localhost:3001';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 20;
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS) || 2000;
const DURATION_MINUTES = parseInt(process.env.DURATION_MINUTES) || 5;

// Multi-collector simulation requires separate collector instances; use one URL here
const CAMERAS = ['cam-001', 'cam-002', 'cam-003'];
const OBJECT_CLASSES = ['pallet', 'forklift', 'worker', 'box', 'container', 'truck'];

class TestDataGenerator {
  constructor() {
    this.objects = new Map();
    this.isRunning = false;
  }

  generateObjectId(prefix = 'obj') {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  getRandomClass() {
    return OBJECT_CLASSES[Math.floor(Math.random() * OBJECT_CLASSES.length)];
  }

  getRandomGridCell() {
    const x = Math.floor(Math.random() * 20);
    const y = Math.floor(Math.random() * 15);
    return `G_${x.toString().padStart(2, '0')}_${y.toString().padStart(2, '0')}`;
  }

  getRandomBbox() {
    return [
      Math.floor(Math.random() * 1000),
      Math.floor(Math.random() * 800),
      50 + Math.floor(Math.random() * 200),
      50 + Math.floor(Math.random() * 200)
    ];
  }

  simulateObjectMovement(objectId, currentCell) {
    if (Math.random() < 0.3) {
      return this.getRandomGridCell();
    }
    
    const [, xStr, yStr] = currentCell.match(/G_(\d+)_(\d+)/) || ['', '0', '0'];
    const x = parseInt(xStr);
    const y = parseInt(yStr);
    
    const moves = [
      [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]
    ].filter(([nx, ny]) => nx >= 0 && nx < 20 && ny >= 0 && ny < 15);
    
    if (moves.length === 0) return currentCell;
    
    const [newX, newY] = moves[Math.floor(Math.random() * moves.length)];
    return `G_${newX.toString().padStart(2, '0')}_${newY.toString().padStart(2, '0')}`;
  }

  createDetectionFrame(cameraId) {
    const timestamp = Date.now();
    const frameId = `${cameraId}-${timestamp}`;

    if (!this.objects.has(cameraId)) {
      this.objects.set(cameraId, []);
    }

    const currentObjects = this.objects.get(cameraId);

    if (Math.random() < 0.2) {
      currentObjects.push({
        object_id: this.generateObjectId(),
        class: this.getRandomClass(),
        grid_cell_id: this.getRandomGridCell(),
        confidence: 0.7 + Math.random() * 0.3,
        last_seen: timestamp
      });
    }

    this.objects.set(cameraId, currentObjects.filter(obj => {
      if (timestamp - obj.last_seen > 30000) {
        return false;
      }

      if (Math.random() < 0.05) {
        return false;
      }

      obj.grid_cell_id = this.simulateObjectMovement(obj.object_id, obj.grid_cell_id);
      obj.last_seen = timestamp;
      obj.confidence = 0.7 + Math.random() * 0.3;
      return true;
    }));

    const objects = this.objects.get(cameraId).map(obj => ({
      object_id: obj.object_id,
      class: obj.class,
      confidence: obj.confidence,
      grid_cell_id: obj.grid_cell_id,
      bbox: this.getRandomBbox()
    }));

    // Frame matches the CameraFrame interface accepted by the collector
    return {
      camera_id: cameraId,
      frame_id: frameId,
      timestamp_ms: timestamp,
      objects
    };
  }

  async sendFrame(frame) {
    try {
      const response = await axios.post(`${COLLECTOR_BASE_URL}/frames`, frame, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      });
      
      console.log(`Sent frame ${frame.frame_id} with ${frame.objects.length} objects`);
      return response.data;
    } catch (error) {
      console.error(`Failed to send frame ${frame.frame_id}:`, error.message);
      throw error;
    }
  }

  async generateBatch() {
    const frames = CAMERAS.map(cameraId => this.createDetectionFrame(cameraId));

    try {
      await Promise.all(frames.map(frame => this.sendFrame(frame)));

      const totalObjects = frames.reduce((sum, frame) => sum + frame.objects.length, 0);
      console.log(`Batch complete: ${frames.length} frames, ${totalObjects} total objects`);

      return { frames: frames.length, objects: totalObjects };
    } catch (error) {
      console.error('Batch failed:', error.message);
      throw error;
    }
  }

  async start() {
    if (this.isRunning) {
      console.log('Generator already running');
      return;
    }

    console.log(`Starting test data generation...`);
    console.log(`Configuration:`);
    console.log(`   - Cameras: ${CAMERAS.join(', ')}`);
    console.log(`   - Batch size: ${BATCH_SIZE} frames`);
    console.log(`   - Interval: ${INTERVAL_MS}ms`);
    console.log(`   - Duration: ${DURATION_MINUTES} minutes`);
    console.log(`   - Target URL: ${COLLECTOR_BASE_URL}`);

    this.isRunning = true;
    const startTime = Date.now();
    const endTime = startTime + (DURATION_MINUTES * 60 * 1000);
    let batchCount = 0;
    let totalFrames = 0;
    let totalObjects = 0;

    while (this.isRunning && Date.now() < endTime) {
      try {
        const result = await this.generateBatch();
        batchCount++;
        totalFrames += result.frames;
        totalObjects += result.objects;
        
        const elapsed = (Date.now() - startTime) / 1000;
        const remaining = Math.max(0, (endTime - Date.now()) / 1000);
        
        console.log(`Stats: ${batchCount} batches, ${totalFrames} frames, ${totalObjects} objects | ${elapsed.toFixed(1)}s elapsed, ${remaining.toFixed(1)}s remaining`);
        
        if (Date.now() < endTime) {
          await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
        }
        
      } catch (error) {
        console.error('Generation error:', error.message);
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 2));
      }
    }

    this.isRunning = false;
    console.log(`Generation complete: ${totalFrames} frames, ${totalObjects} objects in ${batchCount} batches`);
  }

  stop() {
    console.log('Stopping test data generation...');
    this.isRunning = false;
  }
}

async function checkCollectorHealth() {
  try {
    const response = await axios.get(`${COLLECTOR_BASE_URL}/health`, { timeout: 5000 });
    console.log('Collector service is healthy:', response.data);
    return true;
  } catch (error) {
    console.error('Collector service health check failed:', error.message);
    return false;
  }
}

async function main() {
  console.log('Checking collector service...');
  
  const isHealthy = await checkCollectorHealth();
  if (!isHealthy) {
    console.error('Cannot start - collector service is not available');
    console.log('Make sure to start the services first: npm start');
    process.exit(1);
  }

  const generator = new TestDataGenerator();
  
  process.on('SIGINT', () => {
    generator.stop();
  });

  process.on('SIGTERM', () => {
    generator.stop();
  });

  try {
    await generator.start();
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { TestDataGenerator };