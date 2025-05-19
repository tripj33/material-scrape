// direct-ngrok.js - Direct method to start ngrok
const ngrok = require('ngrok');

(async function() {
  try {
    // Disconnect any existing tunnels
    await ngrok.disconnect();
    console.log('Disconnected existing tunnels');
    
    // Start a new tunnel
    const url = await ngrok.connect({
      addr: 3000,
      authtoken: process.env.NGROK_AUTH_TOKEN,
      onStatusChange: (status) => {
        console.log(`Ngrok status: ${status}`);
      },
      onLogEvent: (log) => {
        console.log(`Ngrok log: ${log}`);
      }
    });
    
    console.log(`✅ Ngrok tunnel established: ${url}`);
    console.log(`You can now start your server separately.`);
    
    // Keep the process running
    console.log('Press Ctrl+C to stop the tunnel');
  } catch (error) {
    console.error(`❌ Error starting ngrok: ${error.message}`);
    process.exit(1);
  }
})();