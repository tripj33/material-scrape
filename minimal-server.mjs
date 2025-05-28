// minimal-server.mjs - Minimal server for debugging startup issues
import express from 'express';

console.log('🚀 Starting minimal server...');
console.log('📊 Node.js version:', process.version);
console.log('💾 Memory limit:', process.env.NODE_OPTIONS || 'none set');

const app = express();
app.use(express.json({ limit: '500kb' }));

// Basic health check
app.get('/healthz', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'healthy',
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
    },
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version
  });
});

// Basic test endpoint
app.post('/test', (req, res) => {
  console.log('📥 Test request received');
  res.json({
    success: true,
    message: 'Server is working',
    timestamp: new Date().toISOString()
  });
});

// Start server
const server = app.listen(3000, () => {
  console.log('✅ Minimal server running on port 3000');
  console.log('🔍 Test endpoints:');
  console.log('   GET  http://localhost:3000/healthz');
  console.log('   POST http://localhost:3000/test');
  
  // Test memory
  const mem = process.memoryUsage();
  console.log(`💾 Current memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
  
  // Test GC
  if (typeof global.gc === 'function') {
    console.log('🧹 Garbage collection: Available');
  } else {
    console.log('⚠️ Garbage collection: Not available (missing --expose-gc?)');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔴 Shutting down...');
  server.close(() => {
    console.log('✅ Server stopped');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n🔴 Interrupted by user');
  server.close(() => {
    process.exit(0);
  });
});

console.log('🎯 Minimal server started successfully!');