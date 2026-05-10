#!/usr/bin/env node

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

class VisionLogisticsStarter {
  constructor() {
    this.processes = new Map();
    this.isShuttingDown = false;
    this.config = {
      services: {
        fallbackRedis: { port: 6380, ready: false },
        fallbackKafka: { port: 9093, ready: false },
        collector: { port: 3001, ready: false },
        manager: { port: 3002, ready: false },
        ui: { port: 3000, ready: false }
      },
      timeouts: {
        service: 45000,
        health: 5000,
        startup: 120000
      }
    };
  }

  log(level, message, prefix = '') {
    const timestamp = new Date().toLocaleTimeString();
    const levelColors = {
      info: colors.blue,
      success: colors.green,
      warn: colors.yellow,
      error: colors.red,
      debug: colors.cyan
    };
    
    const color = levelColors[level] || colors.reset;
    const prefixStr = prefix ? `${colors.magenta}[${prefix}]${colors.reset} ` : '';
    
    console.log(`${color}[${timestamp}] ${prefixStr}${message}${colors.reset}`);
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async killProcessOnPort(port) {
    try {
      const { stdout } = await execAsync(`lsof -ti:${port}`);
      if (stdout.trim()) {
        const pids = stdout.trim().split('\n');
        for (const pid of pids) {
          await execAsync(`kill -9 ${pid}`).catch(() => {});
          this.log('warn', `Killed process ${pid} on port ${port}`);
        }
      }
    } catch (error) {
      // Port is free
    }
  }

  async cleanupProcesses() {
    this.log('info', '🧹 Cleaning up existing processes...');
    
    const ports = Object.values(this.config.services).map(s => s.port);
    await Promise.all(ports.map(port => this.killProcessOnPort(port)));
    
    // Kill any remaining tsx processes
    try {
      await execAsync('pkill -f "tsx watch"').catch(() => {});
      await execAsync('pkill -f "node.*fallback"').catch(() => {});
    } catch (error) {
      // No processes to kill
    }
    
    await this.sleep(2000);
  }

  async ensureDependencies() {
    this.log('info', '📦 Ensuring dependencies are installed...');
    
    const workspaces = ['', 'collector', 'manager', 'ui'];
    
    for (const workspace of workspaces) {
      const workDir = workspace ? path.join(__dirname, workspace) : __dirname;
      const packageJsonPath = path.join(workDir, 'package.json');
      
      try {
        await fs.access(packageJsonPath);
        this.log('info', `Installing dependencies in ${workspace || 'root'}...`);
        
        await execAsync('npm install --silent', { cwd: workDir });
        this.log('success', `✅ ${workspace || 'root'} dependencies ready`);
      } catch (error) {
        this.log('error', `Failed to install dependencies in ${workspace || 'root'}: ${error.message}`);
      }
    }
  }

  async createMissingAssets() {
    const viteSvgPath = path.join(__dirname, 'ui', 'public', 'vite.svg');
    try {
      await fs.access(viteSvgPath);
    } catch {
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true" role="img" class="iconify iconify--logos" width="31.88" height="32" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 257"><defs><linearGradient id="IconifyId1813088fe1fbc01fb466" x1="-.828%" x2="57.636%" y1="7.652%" y2="78.411%"><stop offset="0%" stop-color="#41D1FF"></stop><stop offset="100%" stop-color="#BD34FE"></stop></linearGradient><linearGradient id="IconifyId1813088fe1fbc01fb467" x1="43.376%" x2="50.316%" y1="2.242%" y2="89.03%"><stop offset="0%" stop-color="#FFEA83"></stop><stop offset="8.333%" stop-color="#FFDD35"></stop><stop offset="100%" stop-color="#FFA800"></stop></linearGradient></defs><path fill="url(#IconifyId1813088fe1fbc01fb466)" d="M255.153 37.938L134.897 252.976c-2.483 4.44-8.862 4.466-11.382.048L.875 37.958c-2.746-4.814 1.371-10.646 6.827-9.67l120.385 21.517a6.537 6.537 0 0 0 2.322-.004l117.867-21.483c5.438-.991 9.574 4.796 6.877 9.62Z"></path><path fill="url(#IconifyId1813088fe1fbc01fb467)" d="M185.432.063L96.44 17.501a3.268 3.268 0 0 0-2.634 3.014l-5.474 92.456a3.268 3.268 0 0 0 3.997 3.378l24.777-5.718c2.318-.535 4.413 1.507 3.936 3.838l-7.361 36.047c-.495 2.426 1.782 4.5 4.151 3.78l15.304-4.649c2.372-.72 4.652 1.36 4.15 3.788l-11.698 56.621c-.732 3.542 3.979 5.473 5.943 2.437l1.313-2.028l72.516-144.72c1.215-2.423-.88-5.186-3.54-4.672l-25.505 4.922c-2.396.462-4.435-1.77-3.759-4.114l16.646-57.705c.677-2.35-1.37-4.583-3.769-4.113Z"></path></svg>`;
      await fs.mkdir(path.dirname(viteSvgPath), { recursive: true });
      await fs.writeFile(viteSvgPath, svgContent);
      this.log('success', '✅ Created missing vite.svg asset');
    }
  }

  startFallbackRedis() {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, 'scripts', 'redis-fallback.js');
      const redisProcess = spawn('node', [scriptPath], {
        env: { ...process.env, REDIS_FALLBACK_PORT: '6380' },
        stdio: 'pipe'
      });

      redisProcess.stdout.on('data', (data) => {
        if (data.toString().includes('listening on port')) {
          this.config.services.fallbackRedis.ready = true;
          this.log('success', 'Fallback Redis started on port 6380');
          resolve(redisProcess);
        }
      });

      redisProcess.stderr.on('data', (data) => {
        this.log('error', `Redis error: ${data.toString()}`);
      });

      redisProcess.on('exit', (code) => {
        if (code !== 0 && !this.isShuttingDown) {
          reject(new Error(`Redis process exited with code ${code}`));
        }
      });

      this.processes.set('fallbackRedis', redisProcess);

      setTimeout(() => {
        if (!this.config.services.fallbackRedis.ready) {
          reject(new Error('Redis startup timeout'));
        }
      }, 10000);
    });
  }

  startFallbackKafka() {
    return new Promise((resolve, reject) => {
      const kafkaProcess = spawn('node', ['-e', `
        const net = require('net');
        const server = net.createServer((socket) => {
          socket.on('data', () => {
            // Send minimal Kafka protocol response
            const response = Buffer.from([0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
            socket.write(response);
          });
          socket.on('error', () => socket.destroy());
        });
        
        server.listen(9093, () => {
          console.log('Fallback Kafka started on port 9093');
        });
        
        process.on('SIGTERM', () => {
          server.close();
          process.exit(0);
        });
      `], { stdio: 'pipe' });

      kafkaProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Fallback Kafka started')) {
          this.config.services.fallbackKafka.ready = true;
          this.log('success', '✅ Fallback Kafka started on port 9093');
          resolve(kafkaProcess);
        }
      });

      kafkaProcess.stderr.on('data', (data) => {
        this.log('error', `Kafka error: ${data.toString()}`);
      });

      kafkaProcess.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Kafka process exited with code ${code}`));
        }
      });

      this.processes.set('fallbackKafka', kafkaProcess);

      setTimeout(() => {
        if (!this.config.services.fallbackKafka.ready) {
          reject(new Error('Kafka startup timeout'));
        }
      }, 10000);
    });
  }

  async startInfrastructure() {
    this.log('info', '🚀 Starting fallback infrastructure services...');
    
    try {
      await Promise.all([
        this.startFallbackRedis(),
        this.startFallbackKafka()
      ]);
      
      await this.sleep(2000); // Allow services to stabilize
    } catch (error) {
      this.log('error', `Infrastructure startup failed: ${error.message}`);
      throw error;
    }
  }

  startService(name, command, workDir) {
    return new Promise((resolve, reject) => {
      this.log('info', `Starting ${name} service...`);
      
      const env = { 
        ...process.env, 
        FORCE_COLOR: '1',
        KAFKA_BROKERS: 'localhost:9093',
        REDIS_URL: 'redis://localhost:6380'
      };
      
      const serviceProcess = spawn('npm', ['run', 'dev'], {
        cwd: path.join(__dirname, workDir),
        stdio: 'pipe',
        env
      });

      let startupTimeout;
      let isResolved = false;

      const resolveOnce = () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(startupTimeout);
          resolve(serviceProcess);
        }
      };

      serviceProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`${colors.cyan}[${name}]${colors.reset}`, output.trim());
        
        if (output.includes('Server running') || 
            output.includes('ready in') || 
            output.includes('Local:   http://localhost')) {
          this.config.services[name].ready = true;
          this.log('success', `✅ ${name} service started successfully`);
          resolveOnce();
        }
      });

      serviceProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (!output.includes('Warning') && !output.includes('deprecated')) {
          console.log(`${colors.yellow}[${name}]${colors.reset}`, output.trim());
        }
      });

      serviceProcess.on('exit', (code) => {
        this.config.services[name].ready = false;
        if (code !== 0 && !this.isShuttingDown) {
          this.log('error', `${name} service exited with code ${code}`);
        }
      });

      this.processes.set(name, serviceProcess);

      startupTimeout = setTimeout(() => {
        if (!isResolved) {
          this.log('warn', `${name} service is taking a while to start, but continuing...`);
          resolveOnce();
        }
      }, this.config.timeouts.service);
    });
  }

  async startApplicationServices() {
    this.log('info', '🎯 Starting application services...');
    
    const services = [
      { name: 'collector', workDir: 'collector' },
      { name: 'manager', workDir: 'manager' },
      { name: 'ui', workDir: 'ui' }
    ];

    for (const service of services) {
      try {
        await this.startService(service.name, 'dev', service.workDir);
        await this.sleep(1000);
      } catch (error) {
        this.log('error', `Failed to start ${service.name}: ${error.message}`);
      }
    }
  }

  async waitForHealth(serviceName, url, timeout = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(url, { 
          method: 'GET',
          signal: AbortSignal.timeout(this.config.timeouts.health)
        });
        
        if (response.ok) {
          this.log('success', `✅ ${serviceName} is healthy`);
          return true;
        }
      } catch (error) {
        // Continue trying
      }
      
      await this.sleep(2000);
    }
    
    this.log('warn', `⚠️ ${serviceName} may not be fully ready after ${timeout}ms, but continuing...`);
    return false;
  }

  async waitForServices() {
    this.log('info', '⏳ Waiting for services to be ready...');
    
    const healthChecks = [
      { name: 'Collector', url: 'http://localhost:3001/health' },
      { name: 'Manager', url: 'http://localhost:3002/health' },
      { name: 'UI', url: 'http://localhost:3000' }
    ];

    for (const check of healthChecks) {
      await this.waitForHealth(check.name, check.url);
    }
  }

  async displayStatus() {
    this.log('info', '📊 System Status:');
    console.log(`
${colors.bright}🎯 Vision Logistics System${colors.reset}
============================

${colors.green}✅ UI Dashboard:${colors.reset}     http://localhost:3000
${colors.green}✅ Collector API:${colors.reset}   http://localhost:3001  
${colors.green}✅ Manager API:${colors.reset}     http://localhost:3002
${colors.green}✅ Fallback Redis:${colors.reset}  localhost:6380
${colors.green}✅ Fallback Kafka:${colors.reset}  localhost:9093

${colors.bright}🚀 Ready for Demos:${colors.reset}
- ${colors.cyan}npm run demo${colors.reset}                 - Interactive demo menu
- ${colors.cyan}npm run demo-quick${colors.reset}           - 1-minute quick demo  
- ${colors.cyan}npm run demo-visualization${colors.reset}   - Heatwave pattern
- ${colors.cyan}npm run demo-warehouse${colors.reset}       - 3-minute warehouse sim

${colors.yellow}💡 Press Ctrl+C to stop all services${colors.reset}
    `);
  }

  setupSignalHandlers() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      
      this.log('warn', `\n🛑 Received ${signal}, shutting down gracefully...`);
      
      for (const [name, proc] of this.processes) {
        try {
          proc.kill('SIGTERM');
          this.log('info', `Stopped ${name}`);
        } catch (error) {
          // Process already stopped
        }
      }

      await this.sleep(2000);

      // Force kill if needed
      for (const [, proc] of this.processes) {
        try {
          proc.kill('SIGKILL');
        } catch (error) {
          // Process already stopped
        }
      }
      
      this.log('info', '👋 All services stopped');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  async start() {
    console.clear();
    this.log('info', '🎬 Vision Logistics System - Advanced Startup');
    this.log('info', '===============================================\n');

    this.setupSignalHandlers();

    try {
      await this.cleanupProcesses();
      await this.ensureDependencies();
      await this.createMissingAssets();
      await this.startInfrastructure();
      await this.startApplicationServices();
      await this.waitForServices();
      await this.displayStatus();
      
      // Keep the process alive
      await new Promise(() => {});
      
    } catch (error) {
      this.log('error', `🚨 Startup failed: ${error.message}`);
      process.exit(1);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const starter = new VisionLogisticsStarter();
  starter.start().catch(console.error);
}

export default VisionLogisticsStarter;