module.exports = {
  apps: [
    {
      name: "dropbox-downloader",
      script: "./downloader.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "6G",
      env: {
        NODE_ENV: "production",
      },
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      wait_ready: true,
      max_restarts: 10,
      min_uptime: "30s",
      cron_restart: "0 */4 * * *", // Restart every 4 hours
    },
  ],
};
