// PM2 进程守护配置
// 使用：
//   npm i -g pm2
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'erp-mindmap-api',
      script: 'src/server.js',
      cwd: '/www/wwwroot/erp-mindmap/backend', // ← 改成你的后端实际路径
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
        // PORT / JWT_SECRET / ADMIN_* 等从 backend/.env 读取，无需在此重复
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true
    }
  ]
};
