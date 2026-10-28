import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { fmtTime, fmtTimeSec, fmtDate } from './utils/time';
import './assets/main.css';
import './assets/erp.css';

const app = createApp(App);

/**
 * 时间格式化注册成模板全局方法
 * ============================================================
 * 后端 `now()` 存的是 UTC ISO（`new Date().toISOString()`）。
 * 模板里 `(x.created_at || '').slice(0, 16)` 这种写法在 GMT+8 会整整差 8 小时 ——
 * 早上 8 点生成的单据，页面上显示「00:18」。
 *
 * 这类写法曾经散落在 35 个页面、76 处，逐个 `import` 容易漏也容易回潮。
 * 所以统一挂成全局方法，模板里写 `$fmt(x.created_at)` 就行：
 *   $fmt     2026-10-28 08:20
 *   $fmtSec  2026-10-28 08:20:31（日志/备份这类要看秒）
 *   $fmtDate 2026-10-28（只要日期）
 *
 * 实现在 `utils/time.js`：**带时区(Z / ±HH:MM)的转本地，不带时区的原样返回**。
 * 后者很重要 —— `inspect_date`、`taken_at`、`order_date` 本来就是本地字符串，
 * 一律 new Date() 再转会把「2026-10-28」变成「2026-10-27 16:00」。
 */
app.config.globalProperties.$fmt = fmtTime;
app.config.globalProperties.$fmtSec = fmtTimeSec;
app.config.globalProperties.$fmtDate = fmtDate;

app.use(router).mount('#app');
