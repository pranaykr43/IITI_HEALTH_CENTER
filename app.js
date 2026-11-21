// Compatibility entry point for the Express generator's historical `bin/www`.
// The legacy router is intentionally not mounted; the active application lives in src/.
module.exports = require('./src/http/app').createApp().app;
