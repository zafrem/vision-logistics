#!/usr/bin/env node

/**
 * Vision Logistics Individual Module Startup Script
 * 
 * This script starts Redis and runs each module individually to ensure they're working.
 * Perfect for development, testing, and debugging individual components.
 */

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
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

class IndividualModuleStarter {
  constructor() {
    this.processes = new Map();
    this.isShuttingDown = false;
    this.moduleStatuses = new Map();
    this.config = {
      redis: {
        port: 6379,
        fallbackPort: 6380,
        ready: false
      },
      modules: [
        {
          name: 'collector',
          path: 'collector',
          port: 3001,
          healthEndpoint: '/health',
          ready: false
        },
        {
          name: 'manager',
          path: 'manager',
          port: 3002,
          healthEndpoint: '/health',
          ready: false
        },
        {
          name: 'ui',
          path: 'ui',
          port: 3000,
          healthEndpoint: '/',
          ready: false
        }
      ],
      timeouts: {
        service: 30000,
        health: 10000,
        moduleTest: 15000
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
      debug: colors.cyan,
      test: colors.magenta
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
    
    // Kill processes on all configured ports
    const allPorts = [
      this.config.redis.port,
      this.config.redis.fallbackPort,
      ...this.config.modules.map(m => m.port)
    ];
    
    await Promise.all(allPorts.map(port => this.killProcessOnPort(port)));
    
    // Kill any remaining processes
    try {
      await execAsync('pkill -f "tsx watch"').catch(() => {});
      await execAsync('pkill -f "redis-server"').catch(() => {});
      await execAsync('pkill -f "node.*fallback"').catch(() => {});
    } catch (error) {
      // No processes to kill
    }
    
    await this.sleep(2000);
  }

  async checkRedisAvailable() {
    try {
      // Try to connect to standard Redis port
      await execAsync('redis-cli ping', { timeout: 2000 });
      this.log('success', '✅ Found running Redis instance on port 6379');
      return { available: true, port: 6379 };
    } catch (error) {
      this.log('info', 'No Redis instance found on port 6379');
      return { available: false, port: null };
    }
  }

  async startRedis() {
    this.log('info', '🔴 Starting Redis server...');
    
    const redisCheck = await this.checkRedisAvailable();
    if (redisCheck.available) {
      this.config.redis.ready = true;
      this.config.redis.port = redisCheck.port;
      return null; // No process to track since Redis is already running
    }

    // Try to start Redis server
    try {
      const redisProcess = spawn('redis-server', ['--port', this.config.redis.port.toString()], {
        stdio: 'pipe'
      });

      let isResolved = false;
      const startupTimeout = setTimeout(() => {
        if (!isResolved) {
          this.log('warn', 'Redis startup timeout, trying fallback...');
          this.startFallbackRedis().catch(err => {
            this.log('error', `Fallback Redis failed: ${err.message}`);
          });
        }
      }, 10000);

      redisProcess.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Ready to accept connections') && !isResolved) {
          isResolved = true;
          clearTimeout(startupTimeout);
          this.config.redis.ready = true;
          this.log('success', `✅ Redis server started on port ${this.config.redis.port}`);
        }
      });

      redisProcess.stderr.on('data', (data) => {
        const error = data.toString();
        if (error.includes('Address already in use') && !isResolved) {
          isResolved = true;
          clearTimeout(startupTimeout);
          this.log('warn', 'Redis port in use, trying fallback...');
          this.startFallbackRedis().catch(err => {
            this.log('error', `Fallback Redis failed: ${err.message}`);
          });
        } else if (!error.includes('WARNING')) {
          this.log('error', `Redis error: ${error}`);
        }
      });

      redisProcess.on('exit', (code) => {
        this.config.redis.ready = false;
        if (code !== 0 && !this.isShuttingDown) {
          this.log('error', `Redis process exited with code ${code}`);
        }
      });

      this.processes.set('redis', redisProcess);
      return redisProcess;

    } catch (error) {
      this.log('warn', 'Failed to start Redis server, using fallback...');
      return this.startFallbackRedis();
    }
  }

  startFallbackRedis() {
    this.log('info', 'Starting fallback Redis server...');

    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, 'scripts', 'redis-fallback.js');
      const redisProcess = spawn('node', [scriptPath], {
        env: { ...process.env, REDIS_FALLBACK_PORT: String(this.config.redis.fallbackPort) },
        stdio: 'pipe'
      });

      redisProcess.stdout.on('data', (data) => {
        if (data.toString().includes('listening on port')) {
          this.config.redis.ready = true;
          this.config.redis.port = this.config.redis.fallbackPort;
          this.log('success', `Fallback Redis started on port ${this.config.redis.fallbackPort}`);
          resolve(redisProcess);
        }
      });

      redisProcess.stderr.on('data', (data) => {
        this.log('error', `Fallback Redis error: ${data.toString()}`);
      });

      redisProcess.on('exit', (code) => {
        this.config.redis.ready = false;
        if (code !== 0 && !this.isShuttingDown) {
          this.log('error', `Fallback Redis exited with code ${code}`);
        }
      });

      this.processes.set('fallback-redis', redisProcess);

      setTimeout(() => {
        if (!this.config.redis.ready) {
          reject(new Error('Fallback Redis startup timeout'));
        }
      }, 10000);
    });
  }

  async installModuleDependencies(module) {
    this.log('info', `📦 Installing dependencies for ${module.name}...`);
    
    const modulePath = path.join(__dirname, module.path);
    
    try {
      await fs.access(path.join(modulePath, 'package.json'));
      await execAsync('npm install', { cwd: modulePath });
      this.log('success', `✅ ${module.name} dependencies installed`);
      return true;
    } catch (error) {
      this.log('error', `Failed to install ${module.name} dependencies: ${error.message}`);
      return false;
    }
  }

  async startModule(module) {
    this.log('info', `🚀 Starting ${module.name} module...`);
    
    const modulePath = path.join(__dirname, module.path);
    const env = {
      ...process.env,
      FORCE_COLOR: '1',
      REDIS_URL: `redis://localhost:${this.config.redis.port}`,
      KAFKA_BROKERS: 'localhost:9092', // Will fallback internally if not available
      NODE_ENV: 'development'
    };

    const moduleProcess = spawn('npm', ['run', 'dev'], {
      cwd: modulePath,
      stdio: 'pipe',
      env
    });

    let isStarted = false;
    const startupTimeout = setTimeout(() => {
      if (!isStarted) {
        this.log('warn', `${module.name} is taking a while to start...`);
        module.ready = true; // Allow continuation
        this.moduleStatuses.set(module.name, { status: 'timeout', healthy: false });
      }
    }, this.config.timeouts.service);

    moduleProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`${colors.cyan}[${module.name}]${colors.reset}`, output.trim());
      
      if (output.includes('Server running') || 
          output.includes('ready in') || 
          output.includes('Local:   http://localhost') ||
          output.includes('listening on')) {
        if (!isStarted) {
          isStarted = true;
          clearTimeout(startupTimeout);
          module.ready = true;
          this.log('success', `✅ ${module.name} module started on port ${module.port}`);
          this.moduleStatuses.set(module.name, { status: 'started', healthy: false });
        }
      }
    });

    moduleProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (!output.includes('Warning') && !output.includes('deprecated')) {
        console.log(`${colors.yellow}[${module.name}]${colors.reset}`, output.trim());
      }
    });

    moduleProcess.on('exit', (code) => {
      module.ready = false;
      if (code !== 0 && !this.isShuttingDown) {
        this.log('error', `${module.name} module exited with code ${code}`);
        this.moduleStatuses.set(module.name, { status: 'failed', healthy: false, exitCode: code });
      }
    });

    this.processes.set(module.name, moduleProcess);
    return moduleProcess;
  }

  async testModule(module) {
    this.log('test', `🧪 Testing ${module.name} module...`);
    
    const maxAttempts = 5;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        const url = `http://localhost:${module.port}${module.healthEndpoint}`;
        const response = await fetch(url, { 
          method: 'GET',
          signal: AbortSignal.timeout(this.config.timeouts.health)
        });
        
        if (response.ok) {
          this.log('success', `✅ ${module.name} is healthy and responding`);
          this.moduleStatuses.set(module.name, { 
            status: 'healthy', 
            healthy: true, 
            responseStatus: response.status 
          });
          return true;
        } else {
          this.log('warn', `${module.name} responded with status ${response.status}`);
        }
      } catch (error) {
        attempts++;
        if (attempts < maxAttempts) {
          this.log('warn', `${module.name} health check failed (attempt ${attempts}/${maxAttempts}), retrying...`);
          await this.sleep(3000);
        } else {
          this.log('error', `❌ ${module.name} health check failed after ${maxAttempts} attempts`);
          this.moduleStatuses.set(module.name, { 
            status: 'unhealthy', 
            healthy: false, 
            error: error.message 
          });
        }
      }
    }
    
    return false;
  }

  async runModuleTests() {
    this.log('info', '🔬 Running individual module tests...');
    
    for (const module of this.config.modules) {
      if (module.ready) {
        await this.testModule(module);
        await this.sleep(1000); // Brief pause between tests
      } else {
        this.log('warn', `⚠️ Skipping test for ${module.name} (not ready)`);
        this.moduleStatuses.set(module.name, { status: 'not_started', healthy: false });
      }
    }
  }

  displayResults() {
    console.log(`\n${colors.bright}🎯 Vision Logistics Individual Module Report${colors.reset}`);
    console.log('='.repeat(50));

    // Redis Status
    const redisStatus = this.config.redis.ready ? 
      `${colors.green}✅ Running on port ${this.config.redis.port}${colors.reset}` :
      `${colors.red}❌ Failed to start${colors.reset}`;
    console.log(`${colors.bright}Redis:${colors.reset} ${redisStatus}`);

    // Module Status
    console.log(`\n${colors.bright}Modules:${colors.reset}`);
    for (const module of this.config.modules) {
      const status = this.moduleStatuses.get(module.name);
      let statusText = '';
      let healthText = '';

      if (!status) {
        statusText = `${colors.red}❌ Not tested${colors.reset}`;
        healthText = '';
      } else {
        switch (status.status) {
          case 'healthy':
            statusText = `${colors.green}✅ Started${colors.reset}`;
            healthText = `${colors.green}✅ Healthy${colors.reset}`;
            break;
          case 'started':
            statusText = `${colors.green}✅ Started${colors.reset}`;
            healthText = `${colors.yellow}⏳ Testing...${colors.reset}`;
            break;
          case 'unhealthy':
            statusText = `${colors.green}✅ Started${colors.reset}`;
            healthText = `${colors.red}❌ Unhealthy${colors.reset}`;
            break;
          case 'timeout':
            statusText = `${colors.yellow}⚠️ Timeout${colors.reset}`;
            healthText = `${colors.red}❌ Not responding${colors.reset}`;
            break;
          case 'failed':
            statusText = `${colors.red}❌ Failed (exit ${status.exitCode})${colors.reset}`;
            healthText = `${colors.red}❌ Not healthy${colors.reset}`;
            break;
          case 'not_started':
            statusText = `${colors.red}❌ Not started${colors.reset}`;
            healthText = '';
            break;
          default:
            statusText = `${colors.yellow}⚠️ Unknown${colors.reset}`;
            healthText = '';
        }
      }

      console.log(`  ${colors.cyan}${module.name.padEnd(10)}${colors.reset} ${statusText} ${healthText}`);
      console.log(`    ${colors.gray}Port: ${module.port}, Path: ${module.path}${colors.reset}`);
    }

    // Access URLs
    const healthyModules = this.config.modules.filter(m => {
      const status = this.moduleStatuses.get(m.name);
      return status && (status.status === 'healthy' || status.status === 'started');
    });

    if (healthyModules.length > 0) {
      console.log(`\n${colors.bright}🌐 Access URLs:${colors.reset}`);
      for (const module of healthyModules) {
        console.log(`  ${colors.cyan}${module.name}:${colors.reset} http://localhost:${module.port}`);
      }
    }

    // Summary
    const totalModules = this.config.modules.length;
    const healthyCount = this.config.modules.filter(m => {
      const status = this.moduleStatuses.get(m.name);
      return status && status.healthy;
    }).length;

    console.log(`\n${colors.bright}📊 Summary:${colors.reset}`);
    console.log(`  Redis: ${this.config.redis.ready ? 'OK' : 'FAILED'}`);
    console.log(`  Healthy Modules: ${healthyCount}/${totalModules}`);
    
    if (healthyCount === totalModules && this.config.redis.ready) {
      console.log(`\n${colors.green}🎉 All systems are working correctly!${colors.reset}`);
    } else {
      console.log(`\n${colors.yellow}⚠️ Some systems need attention.${colors.reset}`);
    }

    console.log(`\n${colors.bright}💡 Tips:${colors.reset}`);
    console.log(`  • Use ${colors.cyan}Ctrl+C${colors.reset} to stop all services`);
    console.log(`  • Check individual module logs above for detailed error information`);
    console.log(`  • Run ${colors.cyan}npm run validate${colors.reset} for additional system checks`);
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
    this.log('info', '🎬 Vision Logistics Individual Module Tester');
    this.log('info', '==========================================\n');

    this.setupSignalHandlers();

    try {
      // Phase 1: Cleanup and prepare
      await this.cleanupProcesses();
      
      // Phase 2: Start Redis
      await this.startRedis();
      await this.sleep(2000);
      
      if (!this.config.redis.ready) {
        throw new Error('Failed to start Redis - cannot continue');
      }

      // Phase 3: Install dependencies and start modules individually
      for (const module of this.config.modules) {
        this.log('info', `\n--- Testing ${module.name} Module ---`);
        
        // Install dependencies
        const depsInstalled = await this.installModuleDependencies(module);
        if (!depsInstalled) {
          this.log('error', `Skipping ${module.name} due to dependency issues`);
          continue;
        }

        // Start module
        await this.startModule(module);
        
        // Wait a bit for startup
        await this.sleep(3000);
      }

      // Phase 4: Test all modules
      this.log('info', '\n--- Running Health Checks ---');
      await this.runModuleTests();

      // Phase 5: Display results
      this.displayResults();
      
      // Keep the process alive to maintain services
      this.log('info', `\n${colors.yellow}Services are running. Press Ctrl+C to stop all services.${colors.reset}`);
      await new Promise(() => {}); // Keep alive
      
    } catch (error) {
      this.log('error', `🚨 Startup failed: ${error.message}`);
      process.exit(1);
    }
  }
}

// Run the individual module starter if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const starter = new IndividualModuleStarter();
  starter.start().catch(console.error);
}

export default IndividualModuleStarter;