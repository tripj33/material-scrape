// Add this function to create a tunnel if one doesn't exist
async function createTunnel() {
  try {
      console.log('Creating new ngrok tunnel...');
      const url = await ngrok.connect({
          addr: 3000,
          authtoken: process.env.NGROK_AUTH_TOKEN,
          region: 'us',
          bind_tls: true
      });
      
      console.log(`🔗 Created new ngrok tunnel: ${url}`);
      
      // Get details of the active tunnel to save for reuse
      const tunnels = await ngrok.getApi().listTunnels();
      const activeTunnel = tunnels.tunnels.find(t => t.public_url === url);
      
      if (activeTunnel) {
          // Save minimal info needed to reconnect
          const tunnelInfo = {
              name: activeTunnel.name,
              proto: activeTunnel.proto
          };
          
          // Write tunnel info to file
          await fs.writeFile(TUNNEL_CONFIG_FILE, JSON.stringify(tunnelInfo, null, 2));
          console.log('Saved ngrok tunnel info for future restarts');
      }
      
      return true;
  } catch (err) {
      console.error('❌ Failed to create ngrok tunnel:', err);
      return false;
  }
}

// Modify the main function to create a tunnel if needed
async function main() {
  console.log('🚀 Starting ngrok tunnel monitor');
  
  // Check tunnel status immediately
  let tunnelActive = await checkTunnelStatus();
  
  // If tunnel isn't active, create a new one instead of restarting server
  if (!tunnelActive) {
      console.log('No active tunnel found, creating a new one...');
      tunnelActive = await createTunnel();
  }
  
  // Set up recurring checks
  setInterval(async () => {
      tunnelActive = await checkTunnelStatus();
      if (!tunnelActive) {
          console.log('Tunnel not active, creating a new tunnel...');
          tunnelActive = await createTunnel();
      }
  }, CHECK_INTERVAL);
}