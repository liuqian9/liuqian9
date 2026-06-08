// PM2 配置文件 - CLIBOT 后台运行
// 用法: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: "clibot",
    script: "./index.js",
    // 自动重启
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // 日志
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    merge_logs: true,
    // 环境变量（从当前环境继承，Render 上的配置不再需要）
    env: {
      NODE_ENV: "production",
    },
  }],
};
