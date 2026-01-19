module.exports = {
  apps: [{
    name: 'copychu-dashboard',
    script: 'server.js',
    cwd: '/root/copychu-scraper/copychu-dashboard',
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    error_file: '/root/.pm2/logs/copychu-dashboard-error.log',
    out_file: '/root/.pm2/logs/copychu-dashboard-out.log',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
