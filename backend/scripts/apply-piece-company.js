/**
 * 计件工资核算单挂主体（v1.65）
 *
 * ## 为什么这张表必须加列
 *
 * `piece_wage_runs` 是**发钱的实体**：一个月算出一张单，谁是这家公司的人、发多少钱。
 * 它没有 `company_id`，也推不出来 —— 试算 `preview()` 是从全集团的 `production_reports`
 * 里捞报工，按「员工」归人，跟订单没有聚合关系（一个员工一个月可能做了很多张单）。
 *
 * ## 不加列的具体后果（与盘点单那个 bug 同型）
 *
 * - `createRun` 里「同期间已有确认过的核算单就不许再建」查的是全集团：
 *   分部确认了自己的单之后，**总部永远建不了同月的单**，而报错里只会提分部的单号，
 *   现场只能理解成"系统坏了"。
 * - 草案覆盖（重算时删旧草案）也是全集团删：**分部重算会把总部草案删掉**。
 * - 工资单列表/工资条/导出不分主体：分部的计件工资表里混着总部所有人。
 *
 * ## 口径
 *
 * 主体跟**员工**走（钱发给谁）。无法归属到员工的报工不属于任何主体的计件，
 * 但诊断里按订单主体归属，这样分部看得到自己名下的异常（见 services/pieceWage.preview）。
 *
 * 历史 2 张单归默认主体 1（总部）—— 这是事实，不是猜。
 */
const { db } = require('../src/db');

function cols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function main() {
  const c = cols('piece_wage_runs');
  if (!c.includes('company_id')) {
    db.exec('ALTER TABLE piece_wage_runs ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
    console.log('已加列 piece_wage_runs.company_id（历史单据归默认主体 1）');
  } else {
    console.log('piece_wage_runs.company_id 已存在，跳过');
  }

  /**
   * 索引名在 SQLite 里**全局唯一**（不是按表隔离）——
   * v1.64 用 idx_emp_company 时它已被 employments 占用，CREATE INDEX IF NOT EXISTS
   * 直接静默跳过，employees 上一条索引都没建，脚本还打印"成功"。
   * 所以这里建完**回读 sqlite_master 确认落在哪张表上**。
   */
  const IDX = 'idx_piece_run_company';
  db.exec(`CREATE INDEX IF NOT EXISTS ${IDX} ON piece_wage_runs(company_id, period)`);
  const landed = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name = ?").get(IDX);
  if (!landed || landed.tbl_name !== 'piece_wage_runs') {
    throw new Error(`索引 ${IDX} 没有落在 piece_wage_runs 上（实际：${JSON.stringify(landed)}）`);
  }
  console.log(`索引 ${IDX} 已确认在 piece_wage_runs 上`);

  /**
   * 真正的拦路虎：`idx_piece_run_confirmed` 是**部分唯一索引**
   *
   *   CREATE UNIQUE INDEX idx_piece_run_confirmed
   *     ON piece_wage_runs(period) WHERE status = 'confirmed'
   *
   * 「同一期间只能有一张已确认核算单」这条业务规则本身没错，但它没带主体 ——
   * 分部把自己的单确认之后，总部那张同月单**永远确认不了**，报错是
   * `UNIQUE constraint failed: piece_wage_runs.period`，看名字根本想不到是"别家占了"。
   * 加上 company_id，规则原样保留（同一期间同一主体仍只有一张已确认）。
   */
  const conf = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_piece_run_confirmed'").get();
  if (conf && conf.sql && !conf.sql.includes('company_id')) {
    db.exec('DROP INDEX idx_piece_run_confirmed');
    db.exec(
      "CREATE UNIQUE INDEX idx_piece_run_confirmed ON piece_wage_runs(period, company_id) WHERE status = 'confirmed'"
    );
    console.log('已把 idx_piece_run_confirmed 改为按 (period, company_id) 唯一');
  } else {
    console.log('idx_piece_run_confirmed 已带主体，跳过');
  }
  const conf2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_piece_run_confirmed'").get();
  if (!conf2 || !conf2.sql.includes('company_id')) {
    throw new Error('idx_piece_run_confirmed 没改成带主体：' + JSON.stringify(conf2));
  }

  const stat = db.prepare('SELECT company_id, COUNT(*) c FROM piece_wage_runs GROUP BY company_id').all();
  console.log('现有单据主体分布：', JSON.stringify(stat));
}

main();
