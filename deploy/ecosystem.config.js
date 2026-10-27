// PM2 进程守护配置（路径自适应，克隆到任意目录都能用）
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'erp-mindmap-api',
      script: 'src/server.js',
      cwd: path.join(__dirname, '../backend'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
        // PORT / JWT_SECRET / ADMIN_* 等从 backend/.env 读取
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true
    }
  ]
};
