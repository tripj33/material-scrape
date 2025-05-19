const ngrok = require('ngrok');

(async function() {
  try {
    console.log('Starting ngrok tunnel...');
    
    // Start ngrok with minimal configuration
    const url = await ngrok.connect({
      addr: 3000,
      authtoken: process.env.NGROK_AUTH_TOKEN
    });
    
    console.log(`✅ Ngrok tunnel established: ${url}`);
    
    // Write the URL to a file for the server to read
    require('fs').writeFileSync('ngrok-url.txt', url);
  } catch (err) {
    console.error('Error starting ngrok:', err);
  }
})();
