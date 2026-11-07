/** 安装时下载固定版本模型；正常服务完全离线。可显式指定可信下载镜像。 */
const { spawnSync } = require('child_process');
const path = require('path');
const result = spawnSync(process.execPath, [path.resolve(__dirname, '../src/services/sampleImageWorker.js'), '--install'], {
  windowsHide: true, stdio: 'inherit', env: process.env, timeout: 10 * 60000
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
