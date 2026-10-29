import app from './app';
import { connectDB } from './config/db';
import { ENV, configSummary } from './config/env';
import { allowedOrigins } from './config/cors';

const startServer = async () => {
  try {
    // Connect to database
    await connectDB();

    // Start Express Server
    app.listen(ENV.PORT, () => {
      console.log(`🚀 Server running in ${ENV.NODE_ENV} mode on port ${ENV.PORT}`);
      console.log(`Config: ${configSummary()} | CORS allowed=${[...allowedOrigins()].join(' ')}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
