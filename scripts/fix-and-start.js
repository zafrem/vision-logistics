#!/usr/bin/env node

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'green') {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

function error(message) { log(`❌ ${message}`, 'red'); }
function warn(message) { log(`⚠️  ${message}`, 'yellow'); }
function info(message) { log(`ℹ️  ${message}`, 'blue'); }
function success(message) { log(`✅ ${message}`, 'green'); }

// Check if port is in use
function checkPort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(false)); // Port is free
      server.close();
    });
    server.on('error', () => resolve(true)); // Port is in use
  });
}

// Kill process on port
async function killProcessOnPort(port) {
  try {
    const proc = spawn('lsof', ['-ti', `:${port}`]);

    proc.stdout.on('data', (data) => {
      const pids = data.toString().trim().split('\n');
      pids.forEach(pid => {
        if (pid) {
          try {
            log(`Killing process ${pid} on port ${port}`, 'yellow');
            spawn('kill', ['-9', pid]);
          } catch (e) {
            // Ignore errors
          }
        }
      });
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (e) {
    // lsof might not be available, try alternative
    try {
      spawn('pkill', ['-f', `.*${port}`]);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e2) {
      warn(`Could not kill processes on port ${port}. You may need to kill them manually.`);
    }
  }
}

// Install dependencies with retry
async function installDependencies() {
  info('📦 Installing/updating dependencies...');
  
  const packages = [
    { name: 'root', path: projectRoot },
    { name: 'collector', path: path.join(projectRoot, 'collector') },
    { name: 'manager', path: path.join(projectRoot, 'manager') },
    { name: 'ui', path: path.join(projectRoot, 'ui') }
  ];

  for (const pkg of packages) {
    try {
      log(`Installing ${pkg.name} dependencies...`, 'blue');
      
      // Use local cache to avoid permission issues
      const cachePath = path.join(projectRoot, '.npm-local-cache');
      
      await new Promise((resolve, reject) => {
        const child = spawn('npm', ['install', '--cache', cachePath], { 
          cwd: pkg.path,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            success(`${pkg.name} dependencies installed`);
            resolve();
          } else {
            error(`Failed to install ${pkg.name} dependencies`);
            reject(new Error(`npm install failed for ${pkg.name}`));
          }
        });
        
        // Timeout after 60 seconds
        setTimeout(() => {
          child.kill();
          reject(new Error(`Installation timeout for ${pkg.name}`));
        }, 60000);
      });
      
    } catch (err) {
      error(`Failed to install ${pkg.name}: ${err.message}`);
    }
  }
}

// Create vite.svg file to fix the missing resource error
async function createMissingAssets() {
  const viteSvgPath = path.join(projectRoot, 'ui', 'public', 'vite.svg');
  
  try {
    // Create public directory if it doesn't exist
    await fs.mkdir(path.dirname(viteSvgPath), { recursive: true });
    
    // Create a simple SVG icon
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true" role="img" width="31.88" height="32" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 257">
      <defs><linearGradient id="IconifyId1813088fe1fbc01fb466" x1="-.828%" x2="57.636%" y1="7.652%" y2="78.411%"><stop offset="0%" stop-color="#41D1FF"></stop><stop offset="100%" stop-color="#BD34FE"></stop></linearGradient><linearGradient id="IconifyId1813088fe1fbc01fb467" x1="43.376%" x2="50.316%" y1="2.242%" y2="89.03%"><stop offset="0%" stop-color="#FFEA83"></stop><stop offset="8.333%" stop-color="#FFDD35"></stop><stop offset="100%" stop-color="#FFA800"></stop></linearGradient></defs>
      <path fill="url(#IconifyId1813088fe1fbc01fb466)" d="M255.153 37.938L134.897 252.976c-2.483 4.44-8.862 4.466-11.382.048L.875 37.958c-2.746-4.814 1.371-10.646 6.827-9.67l120.385 21.517a6.537 6.537 0 0 0 2.322-.004l117.867-21.483c5.438-.991 9.574 4.796 6.877 9.62Z"></path>
      <path fill="url(#IconifyId1813088fe1fbc01fb467)" d="M185.432.063L96.44 17.501a3.268 3.268 0 0 0-2.634 3.014l-5.474 92.456a3.268 3.268 0 0 0 3.997 3.378l24.777-5.718c2.318-.535 4.413 1.507 3.936 3.838l-7.361 36.047c-.495 2.426 1.782 4.5 4.151 3.78l15.304-4.649c2.372-.72 4.652 1.36 4.15 3.788l-11.698 56.621c-.732 3.542 3.979 5.473 5.943 2.437l1.313-2.028l72.516-144.72c1.215-2.423-.88-5.186-3.54-4.672l-25.505 4.922c-2.396.462-4.435-1.77-3.759-4.114l16.646-57.705c.677-2.35-1.37-4.583-3.769-4.113Z"></path>
    </svg>`;
    
    await fs.writeFile(viteSvgPath, svgContent);
    success('Created missing vite.svg asset');
  } catch (err) {
    warn(`Could not create vite.svg: ${err.message}`);
  }
}

// Proper fallback Redis — spawns scripts/redis-fallback.js
async function startFallbackRedis() {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'redis-fallback.js');
    const child = spawn('node', [scriptPath], {
      env: { ...process.env, REDIS_FALLBACK_PORT: '6380' },
      stdio: 'pipe'
    });

    child.stdout.on('data', (data) => {
      if (data.toString().includes('listening on port')) {
        success('Fallback Redis started on port 6380');
        resolve(child);
      }
    });

    child.stderr.on('data', (data) => {
      error(`Fallback Redis error: ${data.toString()}`);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Fallback Redis exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start fallback Redis: ${err.message}`));
    });

    setTimeout(() => {
      reject(new Error('Fallback Redis startup timeout'));
    }, 10000);
  });
}

// Start fallback Kafka server
async function startFallbackKafka() {
  return new Promise((resolve) => {
    const topics = new Map();
    
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        try {
          const lines = data.toString().split('\n').filter(line => line.trim());
          
          for (const line of lines) {
            try {
              const request = JSON.parse(line);
              
              if (request.type === 'produce') {
                if (!topics.has(request.topic)) {
                  topics.set(request.topic, []);
                }
                const messages = topics.get(request.topic);
                messages.push({
                  timestamp: Date.now(),
                  value: request.message,
                  offset: messages.length
                });
                
                socket.write(JSON.stringify({ success: true }) + '\n');
              } else if (request.type === 'consume') {
                const messages = topics.get(request.topic) || [];
                messages.forEach(message => {
                  socket.write(JSON.stringify({ topic: request.topic, message }) + '\n');
                });
              }
            } catch (parseErr) {
              // Ignore JSON parse errors - might be partial data
            }
          }
        } catch (err) {
          // Ignore data processing errors
        }
      });
      
      socket.on('error', () => {
        // Handle socket errors gracefully
      });
    });
    
    server.listen(9093, () => {
      success('✅ Fallback Kafka started on port 9093');
      resolve(server);
    });
    
    server.on('error', (err) => {
      error(`Failed to start fallback Kafka: ${err.message}`);
      resolve(null);
    });
  });
}

// Start a service with proper error handling
function startService(name, command, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const fullEnv = { ...process.env, ...env };
    
    info(`Starting ${name} service...`);
    
    const child = spawn('npm', ['run', command], {
      cwd: path.join(projectRoot, cwd),
      env: fullEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let hasStarted = false;
    
    child.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`${colors.cyan}[${name}]${colors.reset} ${output.trim()}`);
      
      // Look for startup indicators
      if (!hasStarted && (output.includes('listening') || output.includes('ready') || output.includes('started'))) {
        hasStarted = true;
        success(`${name} service started successfully`);
        resolve(child);
      }
    });
    
    child.stderr.on('data', (data) => {
      const output = data.toString();
      // Only show non-warning stderr
      if (!output.includes('Warning') && !output.includes('DeprecationWarning')) {
        console.error(`${colors.yellow}[${name}]${colors.reset} ${output.trim()}`);
      }
      
      // Some services start successfully but log to stderr
      if (!hasStarted && (output.includes('listening') || output.includes('ready') || output.includes('started'))) {
        hasStarted = true;
        success(`${name} service started successfully`);
        resolve(child);
      }
    });
    
    child.on('close', (code) => {
      if (code !== 0) {
        error(`${name} service exited with code ${code}`);
        if (!hasStarted) {
          reject(new Error(`${name} failed to start`));
        }
      }
    });
    
    child.on('error', (err) => {
      error(`Failed to start ${name}: ${err.message}`);
      if (!hasStarted) {
        reject(err);
      }
    });
    
    // Timeout if service doesn't start in 30 seconds
    setTimeout(() => {
      if (!hasStarted) {
        warn(`${name} service is taking a while to start, but continuing...`);
        hasStarted = true;
        resolve(child);
      }
    }, 30000);
  });
}

// Wait for service to be ready
async function waitForService(port, name, timeout = 60000) {
  const start = Date.now();
  
  info(`Waiting for ${name} to be ready on port ${port}...`);
  
  while (Date.now() - start < timeout) {
    if (await checkPort(port)) {
      // Try to make a simple HTTP request
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
          success(`${name} is ready and responding`);
          return true;
        }
      } catch (e) {
        // Service is running but maybe not ready
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  warn(`${name} may not be fully ready after ${timeout}ms, but continuing...`);
  return false;
}

async function main() {
  console.log('🔧 Vision Logistics System - Fix & Start Tool');
  console.log('==========================================\n');
  
  // Step 1: Clean up any existing processes
  info('🧹 Cleaning up existing processes...');
  await killProcessOnPort(3000);
  await killProcessOnPort(3001);
  await killProcessOnPort(3002);
  await killProcessOnPort(6380);
  await killProcessOnPort(9093);
  
  // Step 2: Install/update dependencies
  await installDependencies();
  
  // Step 3: Create missing assets
  await createMissingAssets();
  
  // Step 4: Start fallback services
  info('🚀 Starting fallback infrastructure services...');
  const redisServer = await startFallbackRedis();
  const kafkaServer = await startFallbackKafka();
  
  if (!redisServer || !kafkaServer) {
    error('Failed to start infrastructure services');
    process.exit(1);
  }
  
  // Wait a moment for services to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Step 5: Start application services
  info('🎯 Starting application services...');
  
  const services = [];
  
  try {
    // Start Collector
    const collector = await startService('Collector', 'dev', 'collector', {
      COLLECTOR_ID: 'collector-01',
      PORT: '3001',
      KAFKA_BROKERS: 'localhost:9093'
    });
    services.push({ name: 'Collector', process: collector, port: 3001 });
    
    // Start Manager
    const manager = await startService('Manager', 'dev', 'manager', {
      PORT: '3002',
      REDIS_URL: 'redis://localhost:6380',
      KAFKA_BROKERS: 'localhost:9093',
      DWELL_TIMEOUT_MS: '30000'
    });
    services.push({ name: 'Manager', process: manager, port: 3002 });
    
    // Start UI
    const ui = await startService('UI', 'dev', 'ui', {
      VITE_API_URL: 'http://localhost:3002'
    });
    services.push({ name: 'UI', process: ui, port: 3000 });
    
  } catch (err) {
    error(`Failed to start services: ${err.message}`);
    process.exit(1);
  }
  
  // Step 6: Wait for services to be ready
  info('⏳ Waiting for services to be ready...');
  
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  for (const service of services) {
    await waitForService(service.port, service.name, 30000);
  }
  
  // Step 7: System ready!
  console.log('\n🎉 System is ready!');
  console.log('==================');
  console.log('');
  console.log('🌐 Access URLs:');
  console.log('  • UI Dashboard: http://localhost:3000');
  console.log('  • Collector API: http://localhost:3001');
  console.log('  • Manager API: http://localhost:3002');
  console.log('');
  console.log('🧪 Next Steps:');
  console.log('  1. Open http://localhost:3000 in your browser');
  console.log('  2. In a new terminal, run: npm run generate-test-data');
  console.log('  3. Watch the heatmap come alive with real-time data!');
  console.log('');
  console.log('🛑 To stop: Press Ctrl+C');
  
  // Handle shutdown gracefully
  const shutdown = () => {
    console.log('\n👋 Shutting down services...');
    
    services.forEach(service => {
      try {
        service.process.kill('SIGTERM');
        log(`Stopped ${service.name}`, 'yellow');
      } catch (e) {
        // Ignore errors during shutdown
      }
    });
    
    if (redisServer) {
      try {
        redisServer.kill('SIGTERM');
        log('Stopped fallback Redis', 'yellow');
      } catch (e) {}
    }

    if (kafkaServer) {
      try {
        kafkaServer.close();
        log('Stopped fallback Kafka', 'yellow');
      } catch (e) {}
    }
    
    success('All services stopped. Goodbye!');
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Handle unhandled errors
process.on('uncaughtException', (err) => {
  error(`Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

main().catch((err) => {
  error(`Fatal error: ${err.message}`);
  process.exit(1);
});