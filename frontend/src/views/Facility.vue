<template>
  <div>
    <div class="page-head">
      <div>
        <h2>后勤管理</h2>
        <div class="sub">宿舍床位 · 饭卡餐补 · 证照印章 · 安全巡检与报修</div>
      </div>
      <button class="btn btn-ghost" @click="loadAll">刷新</button>
    </div>

    <div v-if="s.warnings && s.warnings.length" class="alert-bar">
      <div v-for="(w, i) in s.warnings" :key="i" style="margin: 2px 0">⚠️ {{ w }}</div>
    </div>

    <div class="cards">
      <div class="stat-card">
        <div class="label">宿舍入住率</div>
        <div class="value">{{ (s.dorm && s.dorm.occupancy_rate) || 0 }}<small>%</small></div>
        <div class="delta">住 {{ (s.dorm && s.dorm.occupied) || 0 }} / 可用 {{ ((s.dorm && s.dorm.beds) || 0) - ((s.dorm && s.dorm.maintenance_beds) || 0) }} 床</div>
      </div>
      <div class="stat-card">
        <div class="label">空床 / 维修床</div>
        <div class="value">{{ (s.dorm && s.dorm.free) || 0 }}<small>/ {{ (s.dorm && s.dorm.maintenance_beds) || 0 }}</small></div>
        <div class="delta">维修床不计入可住</div>
      </div>
      <div class="stat-card">
        <div class="label">饭卡余额</div>
        <div class="value">¥{{ money((s.meal && s.meal.personal_total) + (s.meal && s.meal.subsidy_total)) }}</div>
        <div class="delta">个人 ¥{{ money(s.meal && s.meal.personal_total) }} · 补贴 ¥{{ money(s.meal && s.meal.subsidy_total) }}</div>
      </div>
      <div class="stat-card" :class="((s.certificates && (s.certificates.expired + s.certificates.expiring30)) ? 'accent' : '')">
        <div class="label">证照到期预警</div>
        <div class="value">{{ ((s.certificates && s.certificates.expired) || 0) + ((s.certificates && s.certificates.expiring30) || 0) }}<small>张</small></div>
        <div class="delta">已过期 {{ (s.certificates && s.certificates.expired) || 0 }} · 30 天内 {{ (s.certificates && s.certificates.expiring30) || 0 }}</div>
      </div>
      <div class="stat-card" :class="(s.safety && s.safety.to_verify) ? 'accent' : ''">
        <div class="label">维修待复验</div>
        <div class="value">{{ (s.safety && s.safety.to_verify) || 0 }}<small>单</small></div>
        <div class="delta">未闭环 {{ (s.safety && s.safety.open_repairs) || 0 }} · 紧急 {{ (s.safety && s.safety.critical) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">用印待处理</div>
        <div class="value">{{ (s.seals && s.seals.open_usages) || 0 }}<small>笔</small></div>
        <div class="delta">已用未归还 {{ (s.seals && s.seals.used_not_returned) || 0 }}</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <!-- ==================== 宿舍 ==================== -->
    <template v-if="tab === 'dorm'">
      <div class="toolbar" style="margin-bottom: 12px">
        <button class="btn btn-ghost" @click="loadOccupancy">看入住率</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openRoom()">＋ 新增房间</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        <strong>一人同一期间只能一床、一床同一期间只能一人</strong>：入住与预约都按整段区间校验；换宿是原子操作，新床占不上就回滚、原床不动。租金 / 押金 / 水电分栏，押金不自动扣薪。
      </div>

      <div v-if="occupancy" class="alert-bar" style="background: #f2f8ff; border-color: #cfe4ff; color: #1f4f8a">
        {{ occupancy.month }} 入住率 <strong>{{ occupancy.occupancy_rate }}%</strong>：
        住用 {{ occupancy.used_bed_days }} 床日 / 可用 {{ occupancy.available_bed_days }} 床日（可用床 {{ occupancy.usable_beds }} 张，共 {{ occupancy.days }} 天）
      </div>

      <div class="dev-grid">
        <div v-for="r in rooms" :key="r.id" class="dev-card">
          <div class="dev-head">
            <strong>{{ r.building }}{{ r.room_no }}</strong>
            <span class="tag" :class="r.status === 'normal' ? 'blue' : 'red'">{{ r.status_label }}</span>
          </div>
          <div class="muted" style="font-size: 12px">{{ r.gender_label }}生宿舍 · {{ r.beds_count }} 床 · 月租 ¥{{ money(r.rent_month) }} · 押金 ¥{{ money(r.deposit) }}</div>
          <div class="bed-grid">
            <button v-for="b in r.beds" :key="b.id" class="bed-chip"
              :class="{ on: b.occupied, maint: b.status === 'maintenance' }"
              @click="clickBed(r, b)" :disabled="!canWrite">
              <span class="bed-no">{{ b.bed_no }}床</span>
              <span class="bed-who">{{ b.status === 'maintenance' ? '维修' : (b.employee_name || '空') }}</span>
            </button>
          </div>
        </div>
        <div v-if="!rooms.length" class="empty-cell">暂无房间</div>
      </div>

      <div style="font-weight: 700; font-size: 13.5px; margin: 18px 0 8px">住宿记录</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>员工</th><th>位置</th><th>期间</th><th>天数</th><th>租金</th><th>押金</th><th>水电</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in stays" :key="r.id">
              <td class="nowrap"><strong>{{ r.employee_name }}</strong></td>
              <td class="nowrap">{{ r.location }}</td>
              <td class="nowrap">{{ r.start_date }} ~ {{ r.end_date || '在住' }}</td>
              <td class="num">{{ r.days }}</td>
              <td class="num">¥{{ money(r.rent_month) }}</td>
              <td class="num">¥{{ money(r.deposit) }}</td>
              <td class="num">¥{{ money(r.utilities) }}</td>
              <td class="nowrap"><span class="tag" :class="r.status === 'active' ? 'green' : 'gray'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'active'" class="link-btn" @click="doCheckout(r)">退宿</button>
                <button v-if="r.status === 'active'" class="link-btn" @click="openTransfer(r)">换宿</button>
              </td>
            </tr>
            <tr v-if="!stays.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无住宿记录</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 入住 / 房间 / 换宿 弹窗 -->
      <div v-if="dormModal" class="modal-mask" @click.self="dormModal = false">
        <div class="modal">
          <div class="modal-head"><h3>{{ dormTitle }}</h3><button class="link-btn" @click="dormModal = false">关闭</button></div>
          <div class="modal-body">
            <!-- 入住 -->
            <div v-if="dormMode === 'checkin'" class="form-grid">
              <div class="fitem"><label>床位</label><input class="input" :value="dormForm.bedLabel" disabled /></div>
              <div class="fitem"><label>员工 *</label>
                <select class="select" v-model.number="dormForm.employee_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}（{{ e.department_name || '未分配' }}）</option>
                </select>
              </div>
              <div class="fitem"><label>入住日期 *</label><input class="input" type="date" v-model="dormForm.start_date" /></div>
              <div class="fitem"><label>预计退宿（可留空）</label><input class="input" type="date" v-model="dormForm.end_date" /></div>
              <div class="fitem"><label>月租</label><input class="input" type="number" v-model.number="dormForm.rent_month" /></div>
              <div class="fitem"><label>押金</label><input class="input" type="number" v-model.number="dormForm.deposit" /></div>
            </div>
            <!-- 换宿 -->
            <div v-else-if="dormMode === 'transfer'" class="form-grid">
              <div class="fitem"><label>员工 / 原床位</label><input class="input" :value="dormForm.empLabel" disabled /></div>
              <div class="fitem"><label>换入床位 *</label>
                <select class="select" v-model.number="dormForm.bed_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="b in freeBeds" :key="b.id" :value="b.id">{{ b.label }}</option>
                </select>
              </div>
              <div class="fitem"><label>换宿日期 *</label><input class="input" type="date" v-model="dormForm.date" /></div>
            </div>
            <!-- 房间 -->
            <div v-else class="form-grid">
              <div class="fitem"><label>楼房</label><input class="input" v-model="dormForm.building" placeholder="A栋" /></div>
              <div class="fitem"><label>房间号 *</label><input class="input" v-model="dormForm.room_no" /></div>
              <div class="fitem"><label>性别</label>
                <select class="select" v-model="dormForm.gender"><option value="male">男</option><option value="female">女</option></select>
              </div>
              <div class="fitem"><label>床位数</label><input class="input" type="number" v-model.number="dormForm.capacity" /></div>
              <div class="fitem"><label>每床月租</label><input class="input" type="number" v-model.number="dormForm.rent_month" /></div>
              <div class="fitem"><label>每床押金</label><input class="input" type="number" v-model.number="dormForm.deposit" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="dormModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveDorm">{{ dormBtn }}</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 饭卡 ==================== -->
    <template v-if="tab === 'meal'">
      <div class="toolbar" style="margin-bottom: 12px">
        <button class="btn btn-ghost" @click="loadRecon">日结对账</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openMealAccount">＋ 开户</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        账户与卡号分离（换卡只换介质、余额延续）；<strong>个人充值余额与公司补贴分账</strong>，消费优先扣补贴；挂失冻结消费；换卡 / 退款 / 冲正必须带回执号。
      </div>

      <div v-if="recon" class="alert-bar" style="background: #f2f8ff; border-color: #cfe4ff; color: #1f4f8a">
        {{ recon.date }} 日结：{{ recon.count }} 笔 · 补贴入账 ¥{{ money(recon.subsidy_total) }} · 消费 ¥{{ money(recon.consume_total) }}
        <span v-if="recon.issues.length">｜ ⚠️ {{ recon.issues.join('；') }}</span>
        <span v-else>｜ 未发现异常</span>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>员工</th><th>卡号</th><th>个人余额</th><th>补贴余额</th><th>合计</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in accounts" :key="r.id">
              <td class="nowrap"><strong>{{ r.employee_name }}</strong></td>
              <td class="nowrap muted">{{ r.card_no || '未发卡' }}</td>
              <td class="num">¥{{ money(r.balance) }}</td>
              <td class="num">¥{{ money(r.subsidy_balance) }}</td>
              <td class="num"><strong>¥{{ money(r.total_balance) }}</strong></td>
              <td class="nowrap"><span class="tag" :class="r.status === 'active' ? 'green' : r.status === 'lost' ? 'red' : 'gray'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button class="link-btn" @click="openMealTx(r, 'recharge')">充值</button>
                <button class="link-btn" @click="openMealTx(r, 'subsidy')">补贴</button>
                <button class="link-btn" @click="openMealTx(r, 'consume')">消费</button>
                <button v-if="r.status === 'active'" class="link-btn danger" @click="doMealLost(r)">挂失</button>
                <button class="link-btn" @click="doMealReissue(r)">换卡</button>
              </td>
            </tr>
            <tr v-if="!accounts.length"><td :colspan="canWrite ? 7 : 6" class="empty-cell">暂无账户</td></tr>
          </tbody>
        </table>
      </div>

      <div style="font-weight: 700; font-size: 13.5px; margin: 18px 0 8px">餐费流水（最近 30 条）</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>时间</th><th>员工</th><th>类型</th><th>金额</th><th>个人变动</th><th>补贴变动</th><th>来源</th><th>回执号</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="t in txs" :key="t.id">
              <td class="nowrap">{{ $fmt(t.created_at) }}</td>
              <td class="nowrap">{{ t.employee_name }}</td>
              <td class="nowrap">{{ t.type_label }}</td>
              <td class="num">{{ money(t.amount) }}</td>
              <td class="num">{{ t.personal_delta > 0 ? '+' : '' }}{{ money(t.personal_delta) }}</td>
              <td class="num">{{ t.subsidy_delta > 0 ? '+' : '' }}{{ money(t.subsidy_delta) }}</td>
              <td class="nowrap"><span class="tag" :class="t.source === 'device' ? 'blue' : 'gray'">{{ t.source === 'device' ? '设备' : '手工' }}</span></td>
              <td class="nowrap muted">{{ t.receipt_no || '-' }}</td>
              <td style="max-width: 200px; white-space: normal">{{ t.note || '-' }}</td>
            </tr>
            <tr v-if="!txs.length"><td colspan="9" class="empty-cell">暂无流水</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="mealModal" class="modal-mask" @click.self="mealModal = false">
        <div class="modal">
          <div class="modal-head"><h3>{{ mealTitle }}</h3><button class="link-btn" @click="mealModal = false">关闭</button></div>
          <div class="modal-body">
            <div v-if="mealMode === 'account'" class="form-grid">
              <div class="fitem"><label>员工 *</label>
                <select class="select" v-model.number="mealForm.employee_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}</option>
                </select>
              </div>
              <div class="fitem"><label>卡号</label><input class="input" v-model="mealForm.card_no" /></div>
            </div>
            <div v-else class="form-grid">
              <div class="fitem"><label>账户</label><input class="input" :value="mealForm.empLabel" disabled /></div>
              <div class="fitem"><label>金额 *</label><input class="input" type="number" step="0.01" v-model.number="mealForm.amount" /></div>
              <div class="fitem"><label>来源</label>
                <select class="select" v-model="mealForm.source"><option value="manual">手工登记</option><option value="device">设备回执</option></select>
              </div>
              <div class="fitem"><label>回执号</label><input class="input" v-model="mealForm.receipt_no" /></div>
              <div class="fitem full"><label>备注</label><input class="input" v-model="mealForm.note" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px" v-if="mealMode === 'consume'">消费优先扣补贴，补贴不足再扣个人余额。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="mealModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveMeal">确定</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 证照印章 ==================== -->
    <template v-if="tab === 'cert'">
      <div class="toolbar" style="margin-bottom: 12px">
        <button v-if="canWrite" class="btn btn-primary" @click="openCert">＋ 新增证照</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openSeal">＋ 新增印章</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openUsage">＋ 用印申请</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        证照到期进日历（已过期 / 30 天 / 90 天）；<strong>停用置「已停用」不删除</strong>以保留追溯。用印必须绑定文件版本与用途，<strong>版本变了要重新审批</strong>，用印完成留回执并登记归还。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>证照</th><th>类型</th><th>公司</th><th>证号</th><th>有效期至</th><th>剩余</th><th>保管</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in certs" :key="r.id">
              <td class="nowrap"><strong>{{ r.name }}</strong><div class="muted" style="font-size: 12px">{{ r.issued_by || '-' }}</div></td>
              <td class="nowrap">{{ r.type_label }}</td>
              <td class="nowrap">{{ r.company || '-' }}</td>
              <td class="nowrap muted">{{ r.cert_no || '-' }}</td>
              <td class="nowrap">{{ r.expire_date || '长期' }}</td>
              <td class="nowrap">
                <span v-if="r.days_left !== null" :style="r.days_left < 0 ? 'color:#c0392b;font-weight:700' : r.days_left <= 30 ? 'color:#b07b12;font-weight:700' : ''">{{ r.days_left }} 天</span>
                <span v-else class="muted">-</span>
                <div v-if="r.expiring === 'expired'" class="muted" style="font-size: 11.5px; color: #c0392b">已过期</div>
                <div v-else-if="r.expiring === '30'" class="muted" style="font-size: 11.5px; color: #b07b12">30 天内到期</div>
              </td>
              <td class="nowrap">{{ r.holder || '-' }}<div class="muted" style="font-size: 12px">{{ r.location || '' }}</div></td>
              <td class="nowrap"><span class="tag" :class="r.status === 'valid' ? 'green' : 'gray'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'valid'" class="link-btn" @click="openCert(r)">编辑</button>
                <button v-if="r.status === 'valid'" class="link-btn danger" @click="doVoidCert(r)">停用</button>
              </td>
            </tr>
            <tr v-if="!certs.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无证照</td></tr>
          </tbody>
        </table>
      </div>

      <div style="font-weight: 700; font-size: 13.5px; margin: 18px 0 8px">印章与用印记录</div>
      <div class="chips" style="margin-bottom: 10px">
        <span v-for="x in sealList" :key="x.id" class="tag" :class="x.status === 'active' ? 'blue' : 'gray'">
          {{ x.name }}<span v-if="x.company"> · {{ x.company }}</span> · 保管 {{ x.keeper || '-' }}
        </span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>用印单</th><th>印章</th><th>用途 / 文件</th><th>版本</th><th>状态</th><th>回执</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in usages" :key="r.id">
              <td class="nowrap"><strong>{{ r.usage_no }}</strong><div class="muted" style="font-size: 12px">{{ r.applicant || '-' }}</div></td>
              <td class="nowrap">{{ r.seal_name }}<div class="muted" style="font-size: 12px">{{ r.seal_company || '' }}</div></td>
              <td style="max-width: 240px; white-space: normal">{{ r.purpose }}<div class="muted" style="font-size: 11.5px">{{ r.doc_name || '' }}</div></td>
              <td class="nowrap muted">{{ r.doc_version || '-' }}</td>
              <td class="nowrap"><span class="tag" :class="usageTag(r.status)">{{ r.status_label }}</span></td>
              <td class="nowrap muted">{{ r.receipt_no || '-' }}</td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'pending'" class="link-btn" @click="doUsage(r, 'approved')">批准</button>
                <button v-if="r.status === 'approved'" class="link-btn" @click="doUsage(r, 'used')">登记用印</button>
                <button v-if="r.status === 'used'" class="link-btn" @click="doUsage(r, 'returned')">登记归还</button>
                <button v-if="['pending','approved'].includes(r.status)" class="link-btn danger" @click="doUsage(r, 'rejected')">驳回</button>
              </td>
            </tr>
            <tr v-if="!usages.length"><td :colspan="canWrite ? 7 : 6" class="empty-cell">暂无用印记录</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="certModal" class="modal-mask" @click.self="certModal = false">
        <div class="modal wide">
          <div class="modal-head"><h3>{{ certForm.id ? '编辑证照' : '新增证照' }}</h3><button class="link-btn" @click="certModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>名称 *</label><input class="input" v-model="certForm.name" /></div>
              <div class="fitem"><label>类型</label>
                <select class="select" v-model="certForm.type">
                  <option value="license">营业执照</option><option value="permit">许可证</option>
                  <option value="lease">租赁合同</option><option value="insurance">保险</option><option value="other">其他</option>
                </select>
              </div>
              <div class="fitem"><label>公司 / 主体</label><input class="input" v-model="certForm.company" /></div>
              <div class="fitem"><label>证号</label><input class="input" v-model="certForm.cert_no" /></div>
              <div class="fitem"><label>发证机关</label><input class="input" v-model="certForm.issued_by" /></div>
              <div class="fitem"><label>发证日</label><input class="input" type="date" v-model="certForm.issue_date" /></div>
              <div class="fitem"><label>有效期至（长期可留空）</label><input class="input" type="date" v-model="certForm.expire_date" /></div>
              <div class="fitem"><label>保管人</label><input class="input" v-model="certForm.holder" /></div>
              <div class="fitem"><label>存放位置</label><input class="input" v-model="certForm.location" /></div>
              <div class="fitem"><label>备注</label><input class="input" v-model="certForm.remark" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="certModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveCert">保存</button>
          </div>
        </div>
      </div>

      <div v-if="sealModal" class="modal-mask" @click.self="sealModal = false">
        <div class="modal">
          <div class="modal-head"><h3>新增印章</h3><button class="link-btn" @click="sealModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>印章名称 *</label><input class="input" v-model="sealForm.name" placeholder="公章 / 财务章 / 合同章" /></div>
              <div class="fitem"><label>所属公司</label><input class="input" v-model="sealForm.company" /></div>
              <div class="fitem"><label>保管人</label><input class="input" v-model="sealForm.keeper" /></div>
              <div class="fitem full"><label>备注</label><input class="input" v-model="sealForm.remark" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="sealModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveSeal">保存</button>
          </div>
        </div>
      </div>

      <div v-if="usageModal" class="modal-mask" @click.self="usageModal = false">
        <div class="modal">
          <div class="modal-head"><h3>用印申请</h3><button class="link-btn" @click="usageModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>印章 *</label>
                <select class="select" v-model.number="usageForm.seal_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="x in sealList.filter(y => y.status === 'active')" :key="x.id" :value="x.id">{{ x.name }}（{{ x.company }}）</option>
                </select>
              </div>
              <div class="fitem"><label>申请人</label><input class="input" v-model="usageForm.applicant" /></div>
              <div class="fitem full"><label>用途 *</label><input class="input" v-model="usageForm.purpose" placeholder="如 与客户签署合同" /></div>
              <div class="fitem"><label>文件名称</label><input class="input" v-model="usageForm.doc_name" /></div>
              <div class="fitem"><label>文件版本</label><input class="input" v-model="usageForm.doc_version" placeholder="V1" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">审批时如果文件版本已变，会被要求按新版本重新提交。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="usageModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveUsage">提交</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 安全巡检 ==================== -->
    <template v-if="tab === 'safety'">
      <div class="toolbar" style="margin-bottom: 12px">
        <button v-if="canWrite" class="btn btn-primary" @click="openCheck">＋ 登记巡检</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openRepair">＋ 直接报修</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        巡检发现的异常可<strong>一键转报修</strong>并登记停用影响；<strong>维修提交与复验放行分离</strong>——提交只代表修完，要有人复验才闭环；紧急事项允许先登记影响再补流程。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>巡检单</th><th>区域 / 设施</th><th>检查项</th><th>结果</th><th>巡检人</th><th>已转报修</th></tr></thead>
          <tbody>
            <tr v-for="r in checks" :key="r.id">
              <td class="nowrap"><strong>{{ r.check_no }}</strong><div class="muted" style="font-size: 12px">{{ $fmtDate(r.checked_at) }}</div></td>
              <td class="nowrap">{{ r.area_label }}<div class="muted" style="font-size: 12px">{{ r.facility || '-' }}</div></td>
              <td style="max-width: 300px; white-space: normal">
                <span v-for="(it, i) in r.items" :key="i" class="tag" :class="it.result === 'ng' ? 'red' : 'green'" style="margin: 0 4px 4px 0">
                  {{ it.item }}
                </span>
              </td>
              <td class="nowrap"><span class="tag" :class="r.result === 'ok' ? 'green' : 'orange'">{{ r.result_label }}</span></td>
              <td class="nowrap">{{ r.inspector || '-' }}</td>
              <td class="num">{{ r.repair_count }}</td>
            </tr>
            <tr v-if="!checks.length"><td colspan="6" class="empty-cell">暂无巡检记录</td></tr>
          </tbody>
        </table>
      </div>

      <div style="font-weight: 700; font-size: 13.5px; margin: 18px 0 8px">报修单</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>报修单</th><th>区域 / 设施</th><th>问题</th><th>紧急度</th><th>停用影响</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in repairList" :key="r.id">
              <td class="nowrap"><strong>{{ r.repair_no }}</strong><div class="muted" style="font-size: 12px">{{ $fmtDate(r.reported_at) }}</div></td>
              <td class="nowrap">{{ r.area_label }}<div class="muted" style="font-size: 12px">{{ r.facility }}</div></td>
              <td style="max-width: 240px; white-space: normal">{{ r.description || '-' }}</td>
              <td class="nowrap"><span class="tag" :class="r.severity === 'critical' ? 'red' : r.severity === 'major' ? 'orange' : 'gray'">{{ r.severity_label }}</span></td>
              <td class="nowrap muted">{{ r.down_impact || '-' }}</td>
              <td class="nowrap">
                <span class="tag" :class="repairTag(r.status)">{{ r.status_label }}</span>
                <div v-if="r.assignee" class="muted" style="font-size: 11.5px">维修 {{ r.assignee }}</div>
                <div v-if="r.verified_by" class="muted" style="font-size: 11.5px">复验 {{ r.verified_by }}</div>
              </td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'reported'" class="link-btn" @click="doRepair(r, 'repairing')">开始维修</button>
                <button v-if="r.status === 'repairing'" class="link-btn" @click="doRepair(r, 'submitted')">提交维修</button>
                <button v-if="r.status === 'submitted'" class="link-btn" @click="doRepair(r, 'verified')">复验通过</button>
                <button v-if="['verified','rejected'].includes(r.status)" class="link-btn" @click="doRepair(r, 'closed')">关闭</button>
              </td>
            </tr>
            <tr v-if="!repairList.length"><td :colspan="canWrite ? 7 : 6" class="empty-cell">暂无报修</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="checkModal" class="modal-mask" @click.self="checkModal = false">
        <div class="modal wide">
          <div class="modal-head"><h3>登记安全巡检</h3><button class="link-btn" @click="checkModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>区域 *</label>
                <select class="select" v-model="checkForm.area">
                  <option value="dorm">宿舍</option><option value="fire">消防</option>
                  <option value="office">办公</option><option value="production">生产辅助</option>
                </select>
              </div>
              <div class="fitem"><label>设施 / 位置</label><input class="input" v-model="checkForm.facility" /></div>
              <div class="fitem"><label>巡检人</label><input class="input" v-model="checkForm.inspector" /></div>
              <div class="fitem"><label>发现异常自动转报修</label>
                <select class="select" v-model.number="checkForm.create_repairs">
                  <option :value="1">是</option><option :value="0">否</option>
                </select>
              </div>
              <div class="fitem full">
                <label>检查项（每行：项目 | 结果 ok/ng | 备注）</label>
                <textarea v-model="checkForm.itemsText" rows="4" placeholder="灭火器压力表 | ok |&#10;灭火器有效期 | ng | 2 具已过期"></textarea>
              </div>
              <div class="fitem full"><label>备注</label><input class="input" v-model="checkForm.remark" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="checkModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveCheck">提交</button>
          </div>
        </div>
      </div>

      <div v-if="repairModal" class="modal-mask" @click.self="repairModal = false">
        <div class="modal">
          <div class="modal-head"><h3>直接报修</h3><button class="link-btn" @click="repairModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>区域</label>
                <select class="select" v-model="repairForm.area">
                  <option value="dorm">宿舍</option><option value="fire">消防</option>
                  <option value="office">办公</option><option value="production">生产辅助</option>
                </select>
              </div>
              <div class="fitem"><label>设施 *</label><input class="input" v-model="repairForm.facility" /></div>
              <div class="fitem"><label>紧急度</label>
                <select class="select" v-model="repairForm.severity">
                  <option value="critical">紧急</option><option value="major">较严重</option><option value="minor">一般</option>
                </select>
              </div>
              <div class="fitem"><label>负责人</label><input class="input" v-model="repairForm.assignee" /></div>
              <div class="fitem full"><label>问题描述</label><input class="input" v-model="repairForm.description" /></div>
              <div class="fitem full"><label>停用影响</label><input class="input" v-model="repairForm.down_impact" placeholder="如 2 床位不可用" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="repairModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveRepair">提交</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'dorm', label: '宿舍床位' },
  { key: 'meal', label: '饭卡餐补' },
  { key: 'cert', label: '证照印章' },
  { key: 'safety', label: '安全巡检' }
];

const tab = ref('dorm');
const canWrite = computed(() => can('facility.write'));
const s = ref({});
const saving = ref(false);
const formMsg = ref('');
const employees = ref([]);
const activeEmployees = computed(() => employees.value.filter((e) => e.status === 'active'));

const rooms = ref([]);
const stays = ref([]);
const occupancy = ref(null);
const dormModal = ref(false);
const dormMode = ref('checkin');
const dormTitle = ref('入住');
const dormBtn = ref('确定');
const dormForm = reactive({});

const accounts = ref([]);
const txs = ref([]);
const recon = ref(null);
const mealModal = ref(false);
const mealMode = ref('account');
const mealTitle = ref('开户');
const mealForm = reactive({});

const certs = ref([]);
const sealList = ref([]);
const usages = ref([]);
const certModal = ref(false);
const certForm = reactive({});
const sealModal = ref(false);
const sealForm = reactive({});
const usageModal = ref(false);
const usageForm = reactive({});

const checks = ref([]);
const repairList = ref([]);
const checkModal = ref(false);
const checkForm = reactive({});
const repairModal = ref(false);
const repairForm = reactive({});

const money = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

const freeBeds = computed(() => {
  const list = [];
  rooms.value.forEach((r) => {
    r.beds.forEach((b) => {
      if (!b.occupied && b.status !== 'maintenance') list.push({ id: b.id, label: `${r.building || ''}${r.room_no} ${b.bed_no}床` });
    });
  });
  return list;
});

function usageTag(v) {
  return { pending: 'orange', approved: 'blue', used: 'green', returned: 'gray', rejected: 'red' }[v] || 'gray';
}
function repairTag(v) {
  return { reported: 'red', repairing: 'orange', submitted: 'blue', verified: 'green', closed: 'gray', rejected: 'gray' }[v] || 'gray';
}

async function loadAll() {
  try { s.value = await api.facilityStats(); } catch (e) { /* 概览失败不阻塞 */ }
  try { employees.value = await api.employees(); } catch (e) { employees.value = []; }
  await Promise.all([loadDorm(), loadMeal(), loadCert(), loadSafety()]);
}

async function loadDorm() {
  try {
    rooms.value = await api.dormRooms();
    stays.value = await api.dormStays({});
  } catch (e) { alert(e.message); }
}
async function loadOccupancy() {
  try { occupancy.value = await api.dormOccupancy(today().slice(0, 7)); } catch (e) { alert(e.message); }
}
async function loadMeal() {
  try {
    accounts.value = await api.mealAccounts({});
    txs.value = (await api.mealTransactions({})).slice(0, 30);
  } catch (e) { alert(e.message); }
}
async function loadRecon() {
  try { recon.value = await api.mealRecon(today()); } catch (e) { alert(e.message); }
}
async function loadCert() {
  try {
    certs.value = await api.certificates({});
    sealList.value = await api.seals();
    usages.value = await api.sealUsages({});
  } catch (e) { alert(e.message); }
}
async function loadSafety() {
  try {
    checks.value = await api.safetyChecks({});
    repairList.value = await api.repairs({});
  } catch (e) { alert(e.message); }
}

// ---------- 宿舍 ----------
function clickBed(room, bed) {
  formMsg.value = '';
  if (bed.status === 'maintenance') {
    if (confirm(`床位 ${room.building}${room.room_no} ${bed.bed_no} 床正在维修，是否恢复为可用？`)) {
      api.setDormBedStatus(bed.id, { status: 'normal' }).then(loadDorm).catch((e) => alert(e.message));
    }
    return;
  }
  if (bed.occupied) {
    const action = prompt(`该床由 ${bed.employee_name} 在住。\n输入「退宿」办理退宿，输入「维修」标记维修床，其他取消`, '退宿');
    if (action === '退宿') {
      api.dormCheckout(bed.stay_id, {}).then(() => { loadDorm(); loadAll(); }).catch((e) => alert(e.message));
    } else if (action === '维修') {
      api.setDormBedStatus(bed.id, { status: 'maintenance' }).then(loadDorm).catch((e) => alert(e.message));
    }
    return;
  }
  Object.keys(dormForm).forEach((k) => delete dormForm[k]);
  Object.assign(dormForm, {
    bed_id: bed.id, bedLabel: `${room.building || ''}${room.room_no} ${bed.bed_no}床`,
    employee_id: null, start_date: today(), end_date: '',
    rent_month: room.rent_month, deposit: room.deposit
  });
  dormMode.value = 'checkin';
  dormTitle.value = '办理入住';
  dormBtn.value = '入住';
  dormModal.value = true;
}

function openRoom() {
  formMsg.value = '';
  Object.keys(dormForm).forEach((k) => delete dormForm[k]);
  Object.assign(dormForm, { building: '', room_no: '', gender: 'male', capacity: 4, rent_month: 200, deposit: 400 });
  dormMode.value = 'room';
  dormTitle.value = '新增房间';
  dormBtn.value = '创建';
  dormModal.value = true;
}

function openTransfer(stay) {
  formMsg.value = '';
  Object.keys(dormForm).forEach((k) => delete dormForm[k]);
  Object.assign(dormForm, {
    stay_id: stay.id, bed_id: null, date: today(),
    empLabel: `${stay.employee_name} @ ${stay.location}`
  });
  dormMode.value = 'transfer';
  dormTitle.value = '换宿';
  dormBtn.value = '确认换宿';
  dormModal.value = true;
}

async function saveDorm() {
  formMsg.value = '';
  saving.value = true;
  try {
    if (dormMode.value === 'checkin') {
      if (!dormForm.employee_id) { formMsg.value = '请选择员工'; return; }
      await api.dormCheckin({
        bed_id: dormForm.bed_id, employee_id: dormForm.employee_id,
        start_date: dormForm.start_date, end_date: dormForm.end_date || null,
        rent_month: dormForm.rent_month, deposit: dormForm.deposit
      });
    } else if (dormMode.value === 'transfer') {
      if (!dormForm.bed_id) { formMsg.value = '请选择换入床位'; return; }
      await api.dormTransfer({ stay_id: dormForm.stay_id, bed_id: dormForm.bed_id, date: dormForm.date });
    } else {
      if (!dormForm.room_no) { formMsg.value = '请填写房间号'; return; }
      await api.createDormRoom(dormForm);
    }
    dormModal.value = false;
    await loadAll();
    if (occupancy.value) await loadOccupancy();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doCheckout(r) {
  const end = prompt('退宿日期（YYYY-MM-DD）', today());
  if (!end) return;
  try {
    await api.dormCheckout(r.id, { end_date: end });
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 饭卡 ----------
function openMealAccount() {
  formMsg.value = '';
  Object.keys(mealForm).forEach((k) => delete mealForm[k]);
  Object.assign(mealForm, { employee_id: null, card_no: '' });
  mealMode.value = 'account';
  mealTitle.value = '开饭卡';
  mealModal.value = true;
}

function openMealTx(acc, type) {
  formMsg.value = '';
  Object.keys(mealForm).forEach((k) => delete mealForm[k]);
  Object.assign(mealForm, {
    account_id: acc.id, empLabel: acc.employee_name, type, amount: 0,
    source: type === 'consume' ? 'device' : 'manual', receipt_no: '', note: ''
  });
  mealMode.value = type;
  mealTitle.value = { recharge: '个人充值', subsidy: '补贴入账', consume: '消费扣款' }[type];
  mealModal.value = true;
}

async function saveMeal() {
  formMsg.value = '';
  saving.value = true;
  try {
    if (mealMode.value === 'account') {
      if (!mealForm.employee_id) { formMsg.value = '请选择员工'; return; }
      await api.createMealAccount(mealForm);
    } else {
      await api.createMealTx(mealForm);
    }
    mealModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doMealLost(r) {
  const reason = prompt('挂失原因');
  if (reason === null) return;
  try { await api.mealLost(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

async function doMealReissue(r) {
  const card = prompt('新卡号');
  if (!card) return;
  const receipt = prompt('设备回执号（换卡必须有）');
  if (!receipt) { alert('换卡必须填写设备回执号'); return; }
  try { await api.mealReissue(r.id, { card_no: card, receipt_no: receipt }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 证照印章 ----------
function openCert(r) {
  formMsg.value = '';
  Object.keys(certForm).forEach((k) => delete certForm[k]);
  Object.assign(certForm, r ? { ...r } : {
    id: null, name: '', type: 'license', company: '', cert_no: '', issued_by: '',
    issue_date: '', expire_date: '', holder: '', location: '', remark: ''
  });
  certModal.value = true;
}

async function saveCert() {
  formMsg.value = '';
  if (!certForm.name) { formMsg.value = '请填写证照名称'; return; }
  saving.value = true;
  try {
    if (certForm.id) await api.updateCertificate(certForm.id, certForm);
    else await api.createCertificate(certForm);
    certModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doVoidCert(r) {
  const reason = prompt('停用原因（记录保留可追溯）');
  if (!reason) return;
  try { await api.voidCertificate(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

function openSeal() {
  formMsg.value = '';
  Object.keys(sealForm).forEach((k) => delete sealForm[k]);
  Object.assign(sealForm, { name: '', company: '', keeper: '', remark: '' });
  sealModal.value = true;
}

async function saveSeal() {
  formMsg.value = '';
  if (!sealForm.name) { formMsg.value = '请填写印章名称'; return; }
  saving.value = true;
  try {
    await api.createSeal(sealForm);
    sealModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

function openUsage() {
  formMsg.value = '';
  Object.keys(usageForm).forEach((k) => delete usageForm[k]);
  Object.assign(usageForm, { seal_id: null, applicant: '', purpose: '', doc_name: '', doc_version: 'V1' });
  usageModal.value = true;
}

async function saveUsage() {
  formMsg.value = '';
  if (!usageForm.seal_id) { formMsg.value = '请选择印章'; return; }
  if (!usageForm.purpose) { formMsg.value = '请填写用印用途'; return; }
  saving.value = true;
  try {
    await api.createSealUsage(usageForm);
    usageModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doUsage(r, status) {
  let extra = {};
  if (status === 'used') {
    const receipt = prompt('用印回执号（必须填写）');
    if (!receipt) return;
    extra.receipt_no = receipt;
  }
  if (status === 'rejected') {
    const reason = prompt('驳回原因');
    if (!reason) return;
    extra.reason = reason;
  }
  if (status === 'approved' && r.doc_version) extra.doc_version = r.doc_version;
  try {
    await api.setSealUsageStatus(r.id, { status, ...extra });
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 安全巡检 ----------
function openCheck() {
  formMsg.value = '';
  Object.keys(checkForm).forEach((k) => delete checkForm[k]);
  Object.assign(checkForm, {
    area: 'fire', facility: '', inspector: '', create_repairs: 1, itemsText: '', remark: ''
  });
  checkModal.value = true;
}

async function saveCheck() {
  formMsg.value = '';
  saving.value = true;
  try {
    const items = String(checkForm.itemsText || '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const [item, result, note] = l.split('|').map((x) => (x || '').trim());
        return { item, result: /ng|不合格|异常/i.test(result || '') ? 'ng' : 'ok', note: note || '' };
      });
    if (!items.length) { formMsg.value = '请至少填一个检查项'; saving.value = false; return; }
    await api.createSafetyCheck({
      area: checkForm.area, facility: checkForm.facility, inspector: checkForm.inspector,
      items, create_repairs: !!checkForm.create_repairs, remark: checkForm.remark
    });
    checkModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

function openRepair() {
  formMsg.value = '';
  Object.keys(repairForm).forEach((k) => delete repairForm[k]);
  Object.assign(repairForm, { area: 'dorm', facility: '', severity: 'minor', description: '', down_impact: '', assignee: '' });
  repairModal.value = true;
}

async function saveRepair() {
  formMsg.value = '';
  if (!repairForm.facility) { formMsg.value = '请填写报修设施'; return; }
  saving.value = true;
  try {
    await api.createRepair(repairForm);
    repairModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doRepair(r, status) {
  let extra = {};
  if (status === 'repairing') {
    const who = prompt('维修负责人', r.assignee || '');
    if (who === null) return;
    extra.assignee = who;
  }
  if (status === 'submitted') {
    const note = prompt('维修说明（提交后需他人复验才闭环）', '');
    if (note === null) return;
    extra.remark = note;
  }
  if (status === 'verified') {
    const note = prompt('复验结论', '已复验正常');
    if (note === null) return;
    extra.remark = note;
  }
  try {
    await api.setRepairStatus(r.id, { status, ...extra });
    await loadAll();
  } catch (e) { alert(e.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1040px; }
.dev-card { padding: 12px 14px; }
.dev-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; }
.bed-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 10px; }
.bed-chip {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 4px; border: 1px solid #dfe5ef; border-radius: 9px;
  background: #f8fafd; cursor: pointer; font-size: 12px; color: #5b6474;
}
.bed-chip .bed-no { font-weight: 700; color: #16233b; }
.bed-chip .bed-who { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.bed-chip.on { background: #eaf3ff; border-color: #a9cdf7; color: #1f4f8a; }
.bed-chip.maint { background: #fdeeee; border-color: #f0bdbd; color: #b33; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
@media (max-width: 480px) {
  .bed-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
