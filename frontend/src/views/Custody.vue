<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>资产工衣与领归</h2>
        <p class="sub">
          这一页只回答一件事：<b>东西现在在谁身上，什么时候该回来</b>。
          耐用实物（工衣 / 工具 / 钥匙 / 门禁卡）一物一码，<b>同一件不能同时挂在两个人账上</b>；
          劳保消耗品按量领用、领出即核销。
          <b>工衣不强制退回</b>（原型口径），所以它不进超期清单；钥匙、门禁卡、工具才设归还期限。
          折旧不在这里再算一遍 —— 关联资产卡的净值直接读固定资产台账。
        </p>
      </div>
      <div class="head-ops">
        <input v-model="kw" class="input" style="width: 160px" placeholder="单号 / 人名 / 实物" @keyup.enter="reload" />
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card">
        <div class="label">在册实物</div>
        <div class="value">{{ stats.items || 0 }}<small>种</small></div>
        <div class="foot">一物一码 {{ stats.durable_items || 0 }} 种</div>
      </div>
      <div class="stat-card">
        <div class="label">在手上</div>
        <div class="value">{{ stats.open_cnt || 0 }}<small>条</small></div>
        <div class="foot">待归还 {{ stats.awaiting_cnt || 0 }} 条</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.overdue_cnt }">
        <div class="label">超期未还</div>
        <div class="value">{{ stats.overdue_cnt || 0 }}</div>
        <div class="foot">7 天内到期 {{ stats.due_7d || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">不催退回</div>
        <div class="value">{{ stats.optional_out_cnt || 0 }}</div>
        <div class="foot">工衣等 {{ stats.optional_out_qty || 0 }} 件，按政策</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.claim_pending }">
        <div class="label">待复核</div>
        <div class="value">{{ stats.claim_pending || 0 }}</div>
        <div class="foot">损坏 / 遗失</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.claim_unconfirmed }">
        <div class="label">待财务确认</div>
        <div class="value">¥{{ money(stats.claim_unconfirmed_amount) }}</div>
        <div class="foot">已定责未收回 {{ stats.claim_unconfirmed || 0 }} 笔</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'ledger' }" @click="tab = 'ledger'">领用台账（{{ records.length }}）</button>
          <button :class="{ on: tab === 'items' }" @click="tab = 'items'">实物档案（{{ items.length }}）</button>
          <button :class="{ on: tab === 'clear' }" @click="tab = 'clear'">超期与清退（{{ overdue.length }}）</button>
          <button :class="{ on: tab === 'claims' }" @click="tab = 'claims'">损坏复核（{{ claims.length }}）</button>
        </div>
        <div class="head-ops">
          <template v-if="tab === 'ledger'">
            <select v-model="statusFilter" class="select" @change="loadRecords">
              <option value="">全部状态</option>
              <option value="open">在手上（使用中 + 待归还）</option>
              <option value="draft">草稿</option>
              <option value="awaiting">待归还</option>
              <option value="returned">已归还</option>
              <option value="lost">遗失</option>
            </select>
            <select v-model="kindFilter" class="select" @change="loadRecords">
              <option value="">全部类别</option>
              <option v-for="k in meta.kinds || []" :key="k.code" :value="k.code">{{ k.label }}</option>
            </select>
            <button v-if="canIssue" class="btn btn-primary" @click="openIssue()">＋ 登记领用</button>
          </template>
          <template v-else-if="tab === 'items'">
            <button v-action="['custody','create']" v-if="canManage" class="btn btn-primary" @click="openItemForm()">＋ 新建实物</button>
          </template>
          <template v-else-if="tab === 'clear'">
            <button v-if="canManage" class="btn btn-primary" @click="openClearance()">发起离职/调岗清退</button>
          </template>
          <template v-else>
            <button v-if="canClaim" class="btn btn-ghost" @click="openClaim()">手工登记损坏</button>
          </template>
        </div>
      </div>

      <!-- ================= 领用台账 ================= -->
      <div v-if="tab === 'ledger'">
        <div class="notice" v-if="stats.optional_out_cnt">
          工衣等「不强制退回」的实物有 <b>{{ stats.optional_out_cnt }}</b> 条仍在员工手上（共 {{ stats.optional_out_qty }} 件）。
          按政策<b>不催、不算逾期</b>，只在离职清退时列出来让行政决定要不要收回。
        </div>
        <div class="table-wrap" v-if="records.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 128px">单号</th>
                <th style="width: 190px">实物</th>
                <th style="width: 80px">类别</th>
                <th style="width: 150px">领用人</th>
                <th class="num" style="width: 58px">数量</th>
                <th style="width: 104px">发放日</th>
                <th style="width: 128px">应还日</th>
                <th style="width: 96px">状态</th>
                <th style="width: 176px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in records" :key="r.id">
                <td class="nowrap"><a class="lnk" @click="openRecord(r)">{{ r.rec_no }}</a></td>
                <td>
                  <div class="ell"><b>{{ r.item_name || '（实物已删除）' }}</b></div>
                  <div class="tiny mut ell">{{ [r.spec, r.size, r.color].filter(Boolean).join(' / ') || '—' }}</div>
                </td>
                <td><span class="tag gray">{{ r.kind_label }}</span></td>
                <td>
                  <div class="nowrap">{{ r.employee_name }}</div>
                  <div class="tiny mut nowrap">{{ r.dept_name || '—' }}</div>
                </td>
                <td class="num">{{ num(r.qty) }}<span v-if="r.remain_qty && r.remain_qty !== r.qty" class="tiny mut"> / 余{{ r.remain_qty }}</span></td>
                <td class="nowrap tiny">{{ ymd(r.issued_at) || '—' }}</td>
                <td class="nowrap tiny">
                  <span v-if="r.expected_return_at" :class="{ red: r.overdue }">{{ r.expected_return_at }}</span>
                  <span v-else class="mut">{{ Number(r.require_return) ? '未定期限' : '不强制退回' }}</span>
                  <span v-if="r.overdue" class="tag red">逾期 {{ r.overdue_days }} 天</span>
                </td>
                <td><span class="tag" :class="stCls(r.status)">{{ r.status_label }}</span></td>
                <td class="ops">
                  <button v-if="canIssue && r.status === 'draft'" class="btn btn-sm btn-primary" @click="doPublish(r)">发放</button>
                  <button v-if="canIssue && r.is_open" class="btn btn-sm btn-ghost" @click="openReturn(r)">归还</button>
                  <button v-if="canIssue && r.is_open && Number(r.durable)" class="btn btn-sm btn-ghost" @click="openTransfer(r)">转交</button>
                  <button class="btn btn-sm btn-ghost" @click="openRecord(r)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有领用记录。点右上「登记领用」把工衣、钥匙、工具发到人。</div>
      </div>

      <!-- ================= 实物档案 ================= -->
      <div v-else-if="tab === 'items'">
        <div class="table-wrap" v-if="items.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 128px">编号</th>
                <th style="width: 210px">名称 / 规格</th>
                <th style="width: 80px">类别</th>
                <th class="num" style="width: 106px">在册 / 可发</th>
                <th style="width: 120px">归还要求</th>
                <th style="width: 110px">关联资产</th>
                <th style="width: 120px">状态</th>
                <th style="width: 158px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in items" :key="it.id">
                <td class="nowrap">
                  <a class="lnk" @click="openTimeline(it)">{{ it.item_no }}</a>
                  <div v-if="it.item_code" class="tiny mut">{{ it.item_code }}</div>
                </td>
                <td>
                  <div class="ell"><b>{{ it.name }}</b></div>
                  <div class="tiny mut ell">{{ [it.spec, it.size, it.color, it.location].filter(Boolean).join(' / ') || '—' }}</div>
                </td>
                <td><span class="tag gray">{{ it.kind_label }}</span></td>
                <td class="num">
                  {{ num(it.qty_total) }} / <span :class="{ red: !it.available }">{{ it.available }}</span>
                  <div class="tiny mut">{{ it.unit }}</div>
                </td>
                <td class="tiny">
                  <span class="tag" :class="it.require_return ? 'orange' : 'green'">{{ it.return_label }}</span>
                  <div v-if="it.max_per_person" class="mut">上限 {{ it.max_per_person }}/人</div>
                </td>
                <td class="tiny">
                  <template v-if="it.asset_id">
                    <div class="nowrap">{{ it.asset_name }}</div>
                    <div class="mut">净值 ¥{{ money(it.asset_net) }}</div>
                    <div class="mut">{{ it.asset_status_label }}</div>
                  </template>
                  <span v-else class="mut">—</span>
                </td>
                <td>
                  <span class="tag" :class="it.status === 'active' ? 'green' : (it.status === 'hold' ? 'orange' : 'gray')">{{ it.status_label }}</span>
                  <div v-if="it.holder" class="tiny mut">在 {{ it.holder }} 手上</div>
                  <div v-else-if="it.status === 'hold'" class="tiny red nowrap">损坏待定 · 不可发</div>
                </td>
                <td class="ops">
                  <button  v-if="canManage" class="btn btn-sm btn-ghost" @click="openItemForm(it)">编辑</button>
                  <button v-if="canManage && it.status === 'hold'" class="btn btn-sm btn-primary" @click="openRestore(it)">恢复</button>
                  <button v-if="canManage && it.status !== 'scrapped'" class="btn btn-sm btn-ghost" @click="openScrap(it)">处置</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有实物档案。先建工衣尺码、钥匙牌号、工具编号，再发给对应的人。</div>
        <div class="hint-box">
          口径：<b>「一物一码」和「必须归还」是两件事</b>。工衣一物一码（有尺码、要发对人），但按政策不强制退回；
          钥匙、门禁卡、工具必须归还，所以会设期限并进超期清单。消耗品（手套、口罩）按量领用，领出即核销。<br />
          损坏归还的实物会变成<b>「待处理」</b>，可发量归零 —— 修好后点「恢复」，修不好走「处置」。点编号看这件的领用历史。
        </div>
      </div>

      <!-- ================= 超期与清退 ================= -->
      <div v-else-if="tab === 'clear'">
        <div class="col-h">超期未还（只算有期限、要求归还的）</div>
        <div class="table-wrap" v-if="overdue.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 128px">单号</th><th>实物</th><th style="width: 130px">领用人</th>
                <th style="width: 110px">应还日</th><th class="num" style="width: 80px">逾期</th>
                <th style="width: 150px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in overdue" :key="r.id">
                <td class="nowrap">{{ r.rec_no }}</td>
                <td><b>{{ r.item_name }}</b><span class="tiny mut"> · {{ [r.spec, r.size].filter(Boolean).join(' / ') }}</span></td>
                <td class="nowrap">{{ r.employee_name }}<span class="tiny mut"> · {{ r.dept_name || '—' }}</span></td>
                <td class="nowrap tiny">{{ r.expected_return_at }}</td>
                <td class="num red">{{ r.overdue_days }} 天</td>
                <td class="ops">
                  <button v-if="canIssue" class="btn btn-sm btn-primary" @click="openReturn(r)">收回</button>
                  <button class="btn btn-sm btn-ghost" @click="openRecord(r)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">没有超期未还。工衣那类不设期限的不会出现在这里 —— 这是故意的。</div>

        <div class="col-h" style="margin-top: 18px">离职清退单</div>
        <div class="table-wrap" v-if="clearances.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 128px">单号</th><th style="width: 140px">员工</th>
                <th style="width: 110px">离职日</th>
                <th style="width: 150px">必须归还</th><th style="width: 150px">工衣（不强制）</th>
                <th style="width: 90px">状态</th><th style="width: 190px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in clearances" :key="c.id">
                <td class="nowrap">{{ c.clearance_no }}</td>
                <td class="nowrap">{{ c.employee_name }}<div class="tiny mut">{{ c.dept_name || '—' }}</div></td>
                <td class="nowrap tiny">{{ c.leave_date || '—' }}</td>
                <td>
                  <b :class="{ red: c.must_done < c.must_total }">{{ c.must_done }} / {{ c.must_total }}</b>
                  <div v-if="c.must_done < c.must_total" class="tiny red">
                    未回：{{ c.items.filter((x) => x.must && !x.done).map((x) => x.item_name).join('、') }}
                  </div>
                </td>
                <td class="tiny">{{ c.optional_done }} / {{ c.optional_total }}<div class="mut">未退不拦结案</div></td>
                <td><span class="tag" :class="c.status === 'open' ? 'orange' : 'green'">{{ c.status_label }}</span></td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="openClearanceDetail(c)">清单</button>
                  <button v-if="canManage && c.status === 'open'" class="btn btn-sm btn-primary" @click="doCloseClearance(c)">结案</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有离职清退单。员工离职或调岗时点右上「发起离职/调岗清退」，把他名下钥匙、门禁卡、工具一次列清。</div>

        <div class="col-h" style="margin-top: 18px">查某人身上挂着什么</div>
        <div class="row-line">
          <select v-model="personId" class="select" style="width: 220px">
            <option :value="null">选择员工</option>
            <option v-for="e in meta.employees || []" :key="e.id" :value="e.id">{{ e.name }}（{{ e.code || e.id }}）</option>
          </select>
          <button class="btn btn-ghost" @click="loadPerson">查询</button>
        </div>
        <div v-if="person" class="person-box">
          <div class="pb-head">
            <b>{{ person.employee.name }}</b>
            <span class="tag gray">{{ person.employee.dept_name || '未分部门' }}</span>
            <span class="tag" :class="person.employee.status === 'left' ? 'gray' : 'green'">{{ person.employee.status_label }}</span>
            <span class="tiny mut">在手 {{ person.summary.open_cnt }} 条 · 必须归还 {{ person.summary.must_return_cnt }} 条 · 工衣类 {{ person.summary.optional_cnt }} 条 · 超期 {{ person.summary.overdue_cnt }} 条</span>
          </div>
          <table class="data" v-if="person.open.length">
            <thead>
              <tr><th style="width: 128px">单号</th><th>实物</th><th class="num" style="width: 60px">数量</th><th style="width: 110px">应还日</th><th style="width: 120px">状态</th><th style="width: 120px">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in person.open" :key="r.id">
                <td class="nowrap">{{ r.rec_no }}</td>
                <td>{{ r.item_name }}<span class="tiny mut"> · {{ r.kind_label }}</span></td>
                <td class="num">{{ num(r.qty) }}</td>
                <td class="tiny nowrap">
                  <span v-if="r.expected_return_at" :class="{ red: r.overdue }">{{ r.expected_return_at }}</span>
                  <span v-else class="mut">不强制退回</span>
                </td>
                <td><span class="tag" :class="stCls(r.status)">{{ r.status_label }}</span></td>
                <td class="ops"><button v-if="canIssue" class="btn btn-sm btn-ghost" @click="openReturn(r)">收回</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty" style="padding: 12px 2px">这个人手上没有实物。</div>
          <div v-if="person.claims.length" class="tiny mut" style="margin-top: 8px">
            历史损坏复核 {{ person.claims.length }} 笔，其中待确认金额 ¥{{ money(person.summary.claim_unconfirmed_amount) }}
          </div>
        </div>
      </div>

      <!-- ================= 损坏复核 ================= -->
      <div v-else>
        <div class="notice">
          复核只出<b>责任比例与定责金额</b>，<b>不会自动扣工资、也不会自动生成应收</b>。
          金额必须由财务拿回执号确认后才算落地 —— 行政判责、财务收钱，两个动作不能合并。
        </div>
        <div class="table-wrap" v-if="claims.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 128px">单号</th><th>实物 / 情况</th><th style="width: 110px">责任人</th>
                <th style="width: 70px">类型</th><th class="num" style="width: 90px">申报</th>
                <th style="width: 96px">结论</th><th class="num" style="width: 96px">定责金额</th>
                <th style="width: 150px">财务</th><th style="width: 150px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in claims" :key="c.id">
                <td class="nowrap">{{ c.claim_no }}<div class="tiny mut">{{ c.found_at }}</div></td>
                <td>
                  <div class="ell">{{ itemName(c.item_id) }}</div>
                  <div class="tiny mut ell">{{ c.desc_text || '—' }}</div>
                </td>
                <td class="nowrap">{{ c.employee_name || '—' }}</td>
                <td><span class="tag" :class="c.damage_type === 'lost' ? 'red' : 'orange'">{{ c.damage_label }}</span></td>
                <td class="num">{{ money(c.claim_amount) }}</td>
                <td><span class="tag" :class="rvCls(c.review_status)">{{ c.review_label }}</span>
                  <div v-if="c.liable_pct != null" class="tiny mut">{{ c.liable_pct }}%</div>
                </td>
                <td class="num"><b>{{ c.liable_amount == null ? '—' : money(c.liable_amount) }}</b></td>
                <td class="tiny">
                  <span v-if="c.finance_done" class="green-t">已确认 {{ c.finance_confirm_no }}</span>
                  <span v-else-if="c.needs_finance" class="amber-t">待确认（未收回）</span>
                  <span v-else class="mut">—</span>
                </td>
                <td class="ops">
                  <button v-if="canClaim && c.review_status === 'pending'" class="btn btn-sm btn-primary" @click="openReview(c)">复核</button>
                  <button v-if="canFinance && c.needs_finance" class="btn btn-sm btn-primary" @click="openFinance(c)">财务确认</button>
                  <span v-if="c.review_status === 'pending' && !canClaim" class="tiny mut">待复核</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有损坏/遗失复核单。归还时选「损坏」或「遗失」会自动生成；也可手工登记。</div>
      </div>
    </div>

    <!-- ================= 领用弹窗 ================= -->
    <div class="modal-mask" v-if="issueForm.open">
      <div class="modal">
        <div class="modal-head"><b>登记领用</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="issueForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="row">
            <label>实物</label>
            <select v-model="issueForm.item_id" class="select" style="flex: 1; min-width: 240px" @change="onPickItem">
              <option :value="null">选择实物</option>
              <option v-for="it in issuableItems" :key="it.id" :value="it.id">
                {{ it.name }}{{ it.size ? ' ' + it.size : '' }} · {{ it.item_no }} · 可用 {{ it.available }}
              </option>
            </select>
          </div>
          <div class="row" v-if="pickedItem">
            <label>当前</label>
            <span class="tiny">
              <span class="tag" :class="pickedItem.require_return ? 'orange' : 'green'">{{ pickedItem.return_label }}</span>
              <span class="tag gray">{{ pickedItem.durable_label }}</span>
              <span v-if="pickedItem.holder" class="amber-t">在 {{ pickedItem.holder }} 手上（{{ pickedItem.holder_rec_no }}）</span>
              <span v-else class="mut">无人领用</span>
              <span v-if="pickedItem.max_per_person" class="mut"> · 每人上限 {{ pickedItem.max_per_person }}</span>
            </span>
          </div>
          <div class="row">
            <label>领用人</label>
            <select v-model="issueForm.employee_id" class="select" style="flex: 1; min-width: 200px">
              <option :value="null">选择员工</option>
              <option v-for="e in meta.employees || []" :key="e.id" :value="e.id">{{ e.name }}（{{ e.code || e.id }}）</option>
            </select>
          </div>
          <div class="row" v-if="pickedItem && !Number(pickedItem.durable)">
            <label>数量</label>
            <input v-model.number="issueForm.qty" class="input" type="number" min="1" style="width: 100px" />
            <span class="tiny mut">{{ pickedItem.unit }}</span>
          </div>
          <div class="row" v-if="pickedItem && Number(pickedItem.require_return)">
            <label>应还日</label>
            <input v-model="issueForm.expected_return_at" class="input" type="date" style="width: 160px" />
            <span class="tiny mut">可不填 = 未定期限；不填就不算逾期</span>
          </div>
          <div class="row" v-else-if="pickedItem">
            <label>归还</label>
            <span class="tiny amber-t">这类实物不强制退回，不设期限、不进超期清单</span>
          </div>
          <div class="row">
            <label>签收人</label>
            <input v-model="issueForm.handover_by" class="input" style="flex: 1; min-width: 140px" placeholder="本人签收人姓名（可空）" />
          </div>
          <div class="row">
            <label>备注</label>
            <input v-model="issueForm.note" class="input" style="flex: 1; min-width: 200px" placeholder="换季发放 / 新入职 / 借调" />
          </div>
          <div class="row">
            <label></label>
            <label class="ck"><input v-model="issueForm.draft" type="checkbox" /> 只登记草稿（不占实物，发放时才校验）</label>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="issueForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doIssue">{{ issueForm.draft ? '存草稿' : '发放' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 归还弹窗 ================= -->
    <div class="modal-mask" v-if="returnForm.open">
      <div class="modal">
        <div class="modal-head"><b>归还 / 收回 · {{ returnForm.rec ? returnForm.rec.item_name : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="returnForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="returnForm.rec">
          <div class="kv"><span>单号</span><b>{{ returnForm.rec.rec_no }}</b></div>
          <div class="kv"><span>领用人</span><b>{{ returnForm.rec.employee_name }}（{{ returnForm.rec.dept_name || '—' }}）</b></div>
          <div class="kv"><span>未还</span><b>{{ returnForm.rec.remain_qty }} {{ returnForm.rec.unit }}</b></div>
          <div class="row" style="margin-top: 10px">
            <label>实物状态</label>
            <select v-model="returnForm.condition" class="select" style="width: 140px">
              <option value="good">完好</option>
              <option value="worn">磨损（还能用）</option>
              <option value="damaged">损坏</option>
              <option value="lost">遗失</option>
            </select>
            <span class="tiny mut">必须登记 —— 不知道好坏就定不了责</span>
          </div>
          <div class="row" v-if="!Number(returnForm.rec.durable) && returnForm.condition !== 'lost'">
            <label>归还数量</label>
            <input v-model.number="returnForm.qty" class="input" type="number" min="1" style="width: 110px" />
            <span class="tiny mut">不超过 {{ returnForm.rec.remain_qty }}</span>
          </div>
          <div class="row" v-if="returnForm.condition === 'damaged' || returnForm.condition === 'lost'">
            <label>申报金额</label>
            <input v-model.number="returnForm.claim_amount" class="input" type="number" min="0" style="width: 130px" />
            <span class="tiny mut">采购价 / 重置价；先申报，责任由复核认定</span>
          </div>
          <div class="row">
            <label>情况说明</label>
            <textarea v-model="returnForm.note" class="input" rows="2" style="flex: 1; min-width: 240px"
              :placeholder="returnForm.condition === 'good' ? '可空' : '损坏/遗失必须写清经过（复核要依据）'"></textarea>
          </div>
          <div class="notice-warn" v-if="returnForm.condition === 'damaged' || returnForm.condition === 'lost'">
            保存后会生成一张<b>待复核单</b>，但<b>不会自动扣钱</b>；金额要财务拿回执号确认才算落地。
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="returnForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doReturn">确认归还</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 转交弹窗 ================= -->
    <div class="modal-mask" v-if="transferForm.open">
      <div class="modal">
        <div class="modal-head"><b>转交 · {{ transferForm.rec ? transferForm.rec.item_name : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="transferForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="transferForm.rec">
          <div class="notice">转交会<b>先给原领用人记一条归还，再给新领用人开一条新记录</b>（保留「谁用过这件东西」的历史），不是直接改名字。</div>
          <div class="kv"><span>原领用人</span><b>{{ transferForm.rec.employee_name }}</b></div>
          <div class="row">
            <label>转交给</label>
            <select v-model="transferForm.to_employee_id" class="select" style="flex: 1; min-width: 200px">
              <option :value="null">选择员工</option>
              <option v-for="e in meta.employees || []" :key="e.id" :value="e.id">{{ e.name }}（{{ e.code || e.id }}）</option>
            </select>
          </div>
          <div class="row">
            <label>原因</label>
            <input v-model="transferForm.note" class="input" style="flex: 1; min-width: 220px" placeholder="借调 / 换岗 / 临时代用（必填）" />
          </div>
          <div class="row">
            <label>应还日</label>
            <input v-model="transferForm.expected_return_at" class="input" type="date" style="width: 160px" />
            <span class="tiny mut">可空</span>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="transferForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doTransfer">确认转交</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 实物档案弹窗 ================= -->
    <div class="modal-mask" v-if="itemForm.open">
      <div class="modal">
        <div class="modal-head"><b>{{ itemForm.id ? '编辑实物' : '新建实物' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="itemForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="row">
            <label>名称</label>
            <input v-model="itemForm.name" class="input" style="flex: 1; min-width: 200px" placeholder="夏季工衣 / 钥匙 / 电动螺丝刀" />
          </div>
          <div class="row">
            <label>类别</label>
            <select v-model="itemForm.kind" class="select" style="width: 140px">
              <option v-for="k in meta.kinds || []" :key="k.code" :value="k.code">{{ k.label }}</option>
            </select>
            <label class="ck"><input v-model="itemForm.durable" type="checkbox" :true-value="1" :false-value="0" /> 一物一码</label>
            <label class="ck"><input v-model="itemForm.require_return" type="checkbox" :true-value="1" :false-value="0" :disabled="!itemForm.durable" /> 必须归还</label>
          </div>
          <div class="row">
            <label>规格</label>
            <input v-model="itemForm.spec" class="input" style="width: 160px" placeholder="棉 65% / 涤 35%" />
            <label>尺码</label>
            <input v-model="itemForm.size" class="input" style="width: 90px" placeholder="XL" />
            <label>颜色</label>
            <input v-model="itemForm.color" class="input" style="width: 90px" placeholder="藏青" />
          </div>
          <div class="row">
            <label>在册数量</label>
            <input v-model.number="itemForm.qty_total" class="input" type="number" min="1" style="width: 100px" />
            <label>单位</label>
            <input v-model="itemForm.unit" class="input" style="width: 70px" placeholder="件" />
            <label>每人上限</label>
            <input v-model.number="itemForm.max_per_person" class="input" type="number" min="0" style="width: 90px" placeholder="0=不限" />
          </div>
          <div class="row">
            <label>外部编号</label>
            <input v-model="itemForm.item_code" class="input" style="width: 150px" placeholder="胸标 / 钥匙牌号" />
            <label>存放</label>
            <input v-model="itemForm.location" class="input" style="width: 140px" placeholder="钥匙柜 A-03" />
          </div>
          <div class="row">
            <label>关联资产卡</label>
            <input v-model.number="itemForm.asset_id" class="input" type="number" style="width: 130px" placeholder="资产 id（可空）" />
            <span class="tiny mut">挂了资产卡：净值在这里只读，处置要去固定资产页</span>
          </div>
          <div class="row">
            <label>备注</label>
            <input v-model="itemForm.note" class="input" style="flex: 1; min-width: 200px" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="itemForm.open = false">取消</button>
            <button class="btn btn-primary" @click="saveItem">保存</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 处置弹窗 ================= -->
    <div class="modal-mask" v-if="scrapForm.open">
      <div class="modal">
        <div class="modal-head"><b>处置 · {{ scrapForm.item ? scrapForm.item.name : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="scrapForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice-warn">
            处置等于这件东西<b>从账上消失</b>。挂了资产卡的实物不能在这里处置 —— 要去「固定资产」页走报废，
            否则同一台设备会有两个净值。
          </div>
          <div class="row">
            <label>方式</label>
            <select v-model="scrapForm.scrap_mode" class="select" style="width: 150px">
              <option value="dispose">报废变卖</option>
              <option value="transfer">转出</option>
              <option value="write_off">盘亏核销</option>
            </select>
          </div>
          <div class="row">
            <label>单号/回执</label>
            <input v-model="scrapForm.scrap_no" class="input" style="flex: 1; min-width: 200px" placeholder="处置单号或财务回执号（必填）" />
          </div>
          <div class="row">
            <label>说明</label>
            <input v-model="scrapForm.note" class="input" style="flex: 1; min-width: 200px" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="scrapForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doScrap">确认处置</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 恢复可用弹窗 ================= -->
    <div class="modal-mask" v-if="restoreForm.open">
      <div class="modal">
        <div class="modal-head"><b>恢复可用 · {{ restoreForm.item ? restoreForm.item.name : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="restoreForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            归还时登记为损坏的实物会先冻结成「待处理」，避免被再发给下一个人。
            确认已修好或检查后不影响使用，再在这里恢复。
          </div>
          <div class="row">
            <label>处理结果</label>
            <input v-model="restoreForm.note" class="input" style="flex: 1; min-width: 240px" placeholder="已更换屏幕 / 送修回来功能正常 / 检查不影响使用（必填）" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="restoreForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doRestore">恢复可用</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 清退弹窗 ================= -->
    <div class="modal-mask" v-if="clearanceForm.open">
      <div class="modal">
        <div class="modal-head"><b>发起离职/调岗清退</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="clearanceForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            会把该员工名下实物一次列清：<b>钥匙、门禁卡、工具转「待归还」并以离职日为期限</b>；
            <b>工衣只列出来，不改状态、不设期限</b>（不强制退回）。
          </div>
          <div class="row">
            <label>员工</label>
            <select v-model="clearanceForm.employee_id" class="select" style="flex: 1; min-width: 200px">
              <option :value="null">选择员工</option>
              <option v-for="e in meta.employees || []" :key="e.id" :value="e.id">{{ e.name }}（{{ e.code || e.id }}）</option>
            </select>
          </div>
          <div class="row">
            <label>离职日</label>
            <input v-model="clearanceForm.leave_date" class="input" type="date" style="width: 160px" />
          </div>
          <div class="row">
            <label>原因</label>
            <input v-model="clearanceForm.reason" class="input" style="flex: 1; min-width: 200px" placeholder="离职 / 调岗 / 长期休假" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="clearanceForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doBuildClearance">生成清退单</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 清退清单弹窗 ================= -->
    <div class="modal-mask" v-if="clearanceDetail">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left"><b>{{ clearanceDetail.clearance_no }}</b>
            <span class="tag">{{ clearanceDetail.employee_name }}</span>
            <span class="tag gray">离职日 {{ clearanceDetail.leave_date || '—' }}</span>
            <span class="tag" :class="clearanceDetail.status === 'open' ? 'orange' : 'green'">{{ clearanceDetail.status_label }}</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="clearanceDetail = null">关闭</button>
        </div>
        <div class="modal-body">
          <table class="data" v-if="clearanceDetail.items.length">
            <thead><tr><th style="width: 128px">单号</th><th>实物</th><th style="width: 90px">要求</th><th class="num" style="width: 70px">未还</th><th style="width: 110px">应还日</th><th style="width: 100px">状态</th><th style="width: 110px">操作</th></tr></thead>
            <tbody>
              <tr v-for="x in clearanceDetail.items" :key="x.id">
                <td class="nowrap tiny">{{ x.rec_no }}</td>
                <td>{{ x.item_name }}<span class="tiny mut"> · {{ x.kind_label }}</span></td>
                <td><span class="tag" :class="x.must ? 'orange' : 'green'">{{ x.must ? '必须归还' : '不强制' }}</span></td>
                <td class="num">{{ x.remain }}</td>
                <td class="tiny nowrap">{{ x.expected_return_at || '—' }}</td>
                <td class="tiny">{{ x.status_label }}</td>
                <td><button v-if="canIssue && !x.done" class="btn btn-sm btn-ghost" @click="openReturnById(x.id)">收回</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">名下没有实物，可直接结案。</div>
          <div class="modal-foot">
            <button v-if="canManage && clearanceDetail.status === 'open'" class="btn btn-primary" @click="doCloseClearance(clearanceDetail)">结案</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 记录详情 ================= -->
    <div class="modal-mask" v-if="recordDetail">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left"><b>{{ recordDetail.rec_no }}</b>
            <span class="tag">{{ recordDetail.item_name }}</span>
            <span class="tag" :class="stCls(recordDetail.status)">{{ recordDetail.status_label }}</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="recordDetail = null">关闭</button>
        </div>
        <div class="modal-body">
          <div class="kv"><span>领用人</span><b>{{ recordDetail.employee_name }}（{{ recordDetail.dept_name || '—' }}）</b></div>
          <div class="kv"><span>数量</span><b>{{ recordDetail.qty }} {{ recordDetail.unit }}，未还 {{ recordDetail.remain_qty }}</b></div>
          <div class="kv"><span>发放</span><b>{{ recordDetail.issued_at || '—' }} · {{ recordDetail.issued_by || '—' }}</b></div>
          <div class="kv"><span>应还日</span><b>{{ recordDetail.expected_return_at || (Number(recordDetail.require_return) ? '未定期限' : '不强制退回') }}</b></div>
          <div class="kv"><span>归还</span><b>{{ recordDetail.returned_at || '—' }} · {{ recordDetail.returned_qty }} 件 · {{ recordDetail.condition_label || '—' }}</b></div>
          <div class="kv" v-if="recordDetail.prev"><span>来自</span><b>转交自 {{ recordDetail.prev.employee_name }}（{{ recordDetail.prev.rec_no }}）</b></div>
          <div class="kv" v-if="recordDetail.note"><span>备注</span><b>{{ recordDetail.note }}</b></div>

          <div class="col-h" v-if="recordDetail.claims.length">损坏复核</div>
          <table class="data" v-if="recordDetail.claims.length">
            <thead><tr><th>单号</th><th>类型</th><th class="num">申报</th><th>结论</th><th class="num">定责</th><th>财务</th></tr></thead>
            <tbody>
              <tr v-for="c in recordDetail.claims" :key="c.id">
                <td class="nowrap tiny">{{ c.claim_no }}</td>
                <td class="tiny">{{ c.damage_label }}</td>
                <td class="num">{{ money(c.claim_amount) }}</td>
                <td class="tiny">{{ c.review_label }} <span v-if="c.liable_pct != null">（{{ c.liable_pct }}%）</span></td>
                <td class="num">{{ c.liable_amount == null ? '—' : money(c.liable_amount) }}</td>
                <td class="tiny">{{ c.finance_confirm_no || '待确认' }}</td>
              </tr>
            </tbody>
          </table>

          <div class="col-h">时间线</div>
          <div class="tl">
            <div class="tl-row" v-for="a in recordDetail.actions" :key="a.id">
              <span class="tiny mut">{{ a.created_at }}</span>
              <span class="tag gray">{{ actionLabel(a.action) }}</span>
              <span class="tiny">{{ a.detail }}</span>
              <span class="tiny mut">{{ a.actor }}</span>
            </div>
            <div v-if="!recordDetail.actions.length" class="tiny mut">暂无动作</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 实物时间线 ================= -->
    <div class="modal-mask" v-if="timeline">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left"><b>{{ timeline.item.name }}</b>
            <span class="tag gray">{{ timeline.item.item_no }}</span>
            <span class="tag">{{ timeline.item.kind_label }}</span>
            <span class="tag" :class="timeline.item.require_return ? 'orange' : 'green'">{{ timeline.item.return_label }}</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="timeline = null">关闭</button>
        </div>
        <div class="modal-body">
          <div class="kv"><span>在册/可用</span><b>{{ num(timeline.item.qty_total) }} / {{ timeline.item.available }} {{ timeline.item.unit }}</b></div>
          <div class="kv" v-if="timeline.item.asset_id"><span>关联资产</span><b>{{ timeline.item.asset_name }} · 净值 ¥{{ money(timeline.item.asset_net) }}（读自资产台账）</b></div>
          <div class="kv" v-if="timeline.item.status === 'scrapped'"><span>处置</span><b>{{ timeline.item.scrap_mode_label }} · {{ timeline.item.scrap_no }}</b></div>

          <div class="col-h">领用历史</div>
          <table class="data" v-if="timeline.records.length">
            <thead><tr><th style="width: 128px">单号</th><th style="width: 110px">领用人</th><th class="num" style="width: 60px">数量</th><th style="width: 100px">发放</th><th style="width: 100px">归还</th><th style="width: 100px">状态</th></tr></thead>
            <tbody>
              <tr v-for="r in timeline.records" :key="r.id">
                <td class="nowrap tiny">{{ r.rec_no }}</td>
                <td class="nowrap">{{ r.employee_name }}</td>
                <td class="num">{{ num(r.qty) }}</td>
                <td class="tiny nowrap">{{ ymd(r.issued_at) }}</td>
                <td class="tiny nowrap">{{ ymd(r.returned_at) || '—' }}</td>
                <td class="tiny">{{ r.status_label }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="tiny mut">还没有领用记录。</div>

          <div class="col-h">动作日志</div>
          <div class="tl">
            <div class="tl-row" v-for="a in timeline.actions" :key="a.id">
              <span class="tiny mut">{{ a.created_at }}</span>
              <span class="tag gray">{{ actionLabel(a.action) }}</span>
              <span class="tiny">{{ a.detail }}</span>
              <span class="tiny mut">{{ a.actor }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 复核弹窗 ================= -->
    <div class="modal-mask" v-if="reviewForm.open">
      <div class="modal">
        <div class="modal-head"><b>责任复核 · {{ reviewForm.claim ? reviewForm.claim.claim_no : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="reviewForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="reviewForm.claim">
          <div class="kv"><span>实物</span><b>{{ itemName(reviewForm.claim.item_id) }}</b></div>
          <div class="kv"><span>责任人</span><b>{{ reviewForm.claim.employee_name }}</b></div>
          <div class="kv"><span>情况</span><b>{{ reviewForm.claim.desc_text }}</b></div>
          <div class="kv"><span>申报</span><b>¥{{ money(reviewForm.claim.claim_amount) }}</b></div>
          <div class="row" style="margin-top: 10px">
            <label>结论</label>
            <select v-model="reviewForm.decision" class="select" style="width: 130px">
              <option value="cleared">无责</option>
              <option value="partial">部分责任</option>
              <option value="liable">全责</option>
            </select>
            <template v-if="reviewForm.decision === 'partial'">
              <label>比例</label>
              <input v-model.number="reviewForm.liable_pct" class="input" type="number" min="1" max="99" style="width: 90px" /> <span class="tiny">%</span>
            </template>
          </div>
          <div class="row">
            <label>依据</label>
            <textarea v-model="reviewForm.reviewer_note" class="input" rows="2" style="flex: 1; min-width: 240px" placeholder="正常使用磨损 / 违规操作 / 遗失已报警（必填）"></textarea>
          </div>
          <div class="notice-warn">
            复核只出结论与<b>建议金额 ¥{{ previewAmount }}</b>，<b>不会扣工资、不会生成应收</b>；要财务确认回执号后才算落地。
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="reviewForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doReview">提交复核</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 财务确认弹窗 ================= -->
    <div class="modal-mask" v-if="financeForm.open">
      <div class="modal">
        <div class="modal-head"><b>财务确认 · {{ financeForm.claim ? financeForm.claim.claim_no : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="financeForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="financeForm.claim">
          <div class="kv"><span>责任人</span><b>{{ financeForm.claim.employee_name }}</b></div>
          <div class="kv"><span>定责金额</span><b>¥{{ money(financeForm.claim.liable_amount) }}</b></div>
          <div class="row">
            <label>回执号</label>
            <input v-model="financeForm.finance_confirm_no" class="input" style="flex: 1; min-width: 200px" placeholder="收款凭证 / 工资扣款单号（必填）" />
          </div>
          <div class="row">
            <label>说明</label>
            <input v-model="financeForm.finance_note" class="input" style="flex: 1; min-width: 200px" placeholder="已在 10 月工资扣除 / 已收现金" />
          </div>
          <div class="notice">本模块只记录确认结果，<b>不写凭证、不改工资表</b> —— 实际扣款请在薪酬或应收模块做，两边用这个回执号对上。</div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="financeForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doFinance">确认</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 手工登记损坏 ================= -->
    <div class="modal-mask" v-if="claimForm.open">
      <div class="modal">
        <div class="modal-head"><b>手工登记损坏 / 遗失</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="claimForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="row">
            <label>实物</label>
            <select v-model="claimForm.item_id" class="select" style="flex: 1; min-width: 220px">
              <option :value="null">选择实物</option>
              <option v-for="it in items" :key="it.id" :value="it.id">{{ it.name }}{{ it.size ? ' ' + it.size : '' }} · {{ it.item_no }}</option>
            </select>
          </div>
          <div class="row">
            <label>责任人</label>
            <select v-model="claimForm.employee_id" class="select" style="flex: 1; min-width: 200px">
              <option :value="null">选择员工</option>
              <option v-for="e in meta.employees || []" :key="e.id" :value="e.id">{{ e.name }}（{{ e.code || e.id }}）</option>
            </select>
          </div>
          <div class="row">
            <label>类型</label>
            <select v-model="claimForm.damage_type" class="select" style="width: 120px">
              <option value="damaged">损坏</option>
              <option value="lost">遗失</option>
            </select>
            <label>发现日</label>
            <input v-model="claimForm.found_at" class="input" type="date" style="width: 150px" />
            <label>申报金额</label>
            <input v-model.number="claimForm.claim_amount" class="input" type="number" min="0" style="width: 110px" />
          </div>
          <div class="row">
            <label>情况</label>
            <textarea v-model="claimForm.desc_text" class="input" rows="2" style="flex: 1; min-width: 240px" placeholder="必填"></textarea>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="claimForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doCreateClaim">登记</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('ledger');
const kw = ref('');
const statusFilter = ref('open');
const kindFilter = ref('');

const meta = ref({});
const stats = ref({});
const records = ref([]);
const items = ref([]);
const overdue = ref([]);
const clearances = ref([]);
const claims = ref([]);

const recordDetail = ref(null);
const timeline = ref(null);
const clearanceDetail = ref(null);
const person = ref(null);
const personId = ref(null);

const canIssue = computed(() => can('custody.issue'));
const canManage = computed(() => can('custody.manage'));
const canClaim = computed(() => can('custody.claim'));
const canFinance = computed(() => can('custody.finance'));

const num = (v) => Number(v || 0);
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// 日期一律按本地取，别用 toISOString（UTC 会差一天）
const ymdLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ymd = (s) => (s ? String(s).slice(0, 10) : '');

const stCls = (s) => ({ issued: 'green', awaiting: 'orange', returned: 'gray', draft: 'gray', lost: 'red', written_off: 'gray' }[s] || 'gray');
const rvCls = (s) => ({ pending: 'orange', cleared: 'gray', partial: 'orange', liable: 'red', closed: 'gray' }[s] || 'gray');
const ACTION_LABEL = {
  create: '建档', update: '改档', issue: '发放', draft: '草稿', return: '归还', lost: '遗失',
  claim: '发起复核', review: '复核', finance: '财务确认', scrap: '处置', hold: '冻结待处理',
  restore: '恢复可用', transfer_out: '转交出', transfer_in: '转交入', close: '结案'
};
const actionLabel = (a) => ACTION_LABEL[a] || a;
const itemName = (id) => {
  const it = items.value.find((x) => x.id === id);
  return it ? `${it.name}${it.size ? ' ' + it.size : ''}` : `实物 #${id}`;
};

/* ---------------- 数据加载 ---------------- */
async function reload() {
  try {
    const [m, b] = await Promise.all([api.cuMeta(), api.cuBoard()]);
    meta.value = m || {};
    stats.value = (b && b.stats) || m.stats || {};
    await Promise.all([loadRecords(), loadItems(), loadClearTab(), loadClaims()]);
  } catch (e) {
    alert(e.message);
  }
}

async function loadRecords() {
  try {
    records.value = (await api.cuRecords({ status: statusFilter.value, kind: kindFilter.value, q: kw.value })) || [];
  } catch (e) { alert(e.message); }
}

async function loadItems() {
  try {
    items.value = (await api.cuItems({ q: kw.value })) || [];
  } catch (e) { alert(e.message); }
}

async function loadClearTab() {
  try {
    const [o, c] = await Promise.all([api.cuOverdue(), api.cuClearances({})]);
    overdue.value = o || [];
    clearances.value = c || [];
  } catch (e) { alert(e.message); }
}

async function loadClaims() {
  try {
    claims.value = (await api.cuClaims({ q: kw.value })) || [];
  } catch (e) { alert(e.message); }
}

/* ---------------- 领用 ---------------- */
const issueForm = reactive({
  open: false, item_id: null, employee_id: null, qty: 1, expected_return_at: '',
  handover_by: '', note: '', draft: false
});
const pickedItem = computed(() => items.value.find((x) => x.id === issueForm.item_id) || null);
// 只列还能领的；已全部在手上的不混进来，避免「点了才知道不行」
const issuableItems = computed(() => items.value.filter((x) => x.status === 'active'));

function openIssue(item) {
  Object.assign(issueForm, {
    open: true, item_id: item ? item.id : null, employee_id: null, qty: 1,
    expected_return_at: '', handover_by: '', note: '', draft: false
  });
}
function onPickItem() {
  const it = pickedItem.value;
  issueForm.qty = it && Number(it.durable) ? 1 : 1;
}

async function doIssue() {
  if (!issueForm.item_id) return alert('请选择实物');
  if (!issueForm.employee_id) return alert('请选择领用人');
  try {
    await api.cuCreateRecord({
      item_id: issueForm.item_id,
      employee_id: issueForm.employee_id,
      qty: issueForm.qty,
      expected_return_at: issueForm.expected_return_at || undefined,
      handover_by: issueForm.handover_by || undefined,
      note: issueForm.note || undefined,
      draft: issueForm.draft || undefined
    });
    issueForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

async function doPublish(r) {
  try {
    await api.cuPublish(r.id);
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 归还 ---------------- */
const returnForm = reactive({ open: false, rec: null, condition: 'good', qty: 1, claim_amount: 0, note: '' });

function openReturn(r) {
  Object.assign(returnForm, { open: true, rec: r, condition: 'good', qty: num(r.remain_qty) || 1, claim_amount: 0, note: '' });
}
async function openReturnById(id) {
  try {
    const d = await api.cuRecord(id);
    openReturn(d);
  } catch (e) { alert(e.message); }
}

async function doReturn() {
  const r = returnForm.rec;
  if (!r) return;
  if (['damaged', 'lost'].includes(returnForm.condition) && !returnForm.note.trim()) {
    return alert('登记损坏/遗失必须写情况说明');
  }
  try {
    await api.cuReturn(r.id, {
      condition: returnForm.condition,
      qty: Number(r.durable) ? undefined : returnForm.qty,
      claim_amount: returnForm.claim_amount || 0,
      note: returnForm.note || undefined
    });
    returnForm.open = false;
    if (clearanceDetail.value) await openClearanceDetailById(clearanceDetail.value.id);
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 转交 ---------------- */
const transferForm = reactive({ open: false, rec: null, to_employee_id: null, note: '', expected_return_at: '' });
function openTransfer(r) {
  Object.assign(transferForm, { open: true, rec: r, to_employee_id: null, note: '', expected_return_at: '' });
}
async function doTransfer() {
  const r = transferForm.rec;
  if (!r) return;
  if (!transferForm.to_employee_id) return alert('请选择转交对象');
  if (!transferForm.note.trim()) return alert('转交要写原因');
  try {
    await api.cuTransfer(r.id, {
      to_employee_id: transferForm.to_employee_id,
      note: transferForm.note,
      expected_return_at: transferForm.expected_return_at || undefined
    });
    transferForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 实物档案 ---------------- */
const itemForm = reactive({
  open: false, id: null, name: '', kind: 'uniform', durable: 1, require_return: 1,
  spec: '', size: '', color: '', qty_total: 1, unit: '件', max_per_person: 0,
  item_code: '', location: '', asset_id: null, note: ''
});

function openItemForm(it) {
  if (it) {
    Object.assign(itemForm, {
      open: true, id: it.id, name: it.name, kind: it.kind, durable: Number(it.durable),
      require_return: Number(it.require_return), spec: it.spec || '', size: it.size || '', color: it.color || '',
      qty_total: it.qty_total, unit: it.unit || '件', max_per_person: it.max_per_person || 0,
      item_code: it.item_code || '', location: it.location || '', asset_id: it.asset_id || null, note: it.note || ''
    });
  } else {
    Object.assign(itemForm, {
      open: true, id: null, name: '', kind: 'uniform', durable: 1, require_return: 1,
      spec: '', size: '', color: '', qty_total: 1, unit: '件', max_per_person: 0,
      item_code: '', location: '', asset_id: null, note: ''
    });
  }
}

async function saveItem() {
  if (!itemForm.name.trim()) return alert('实物名称必填');
  try {
    await api.cuSaveItem({
      id: itemForm.id || undefined,
      name: itemForm.name, kind: itemForm.kind, durable: itemForm.durable,
      require_return: itemForm.require_return, spec: itemForm.spec || undefined,
      size: itemForm.size || undefined, color: itemForm.color || undefined,
      qty_total: itemForm.qty_total, unit: itemForm.unit || '件',
      max_per_person: itemForm.max_per_person || 0,
      item_code: itemForm.item_code || undefined, location: itemForm.location || undefined,
      asset_id: itemForm.asset_id || undefined, note: itemForm.note || undefined
    });
    itemForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 处置 ---------------- */
const restoreForm = reactive({ open: false, item: null, note: '' });
function openRestore(it) {
  Object.assign(restoreForm, { open: true, item: it, note: '' });
}
async function doRestore() {
  if (!restoreForm.note.trim()) return alert('请写处理结果（维修 / 检查合格）');
  try {
    await api.cuRestore(restoreForm.item.id, { note: restoreForm.note });
    restoreForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

const scrapForm = reactive({ open: false, item: null, scrap_mode: 'write_off', scrap_no: '', note: '' });
function openScrap(it) {
  Object.assign(scrapForm, { open: true, item: it, scrap_mode: 'write_off', scrap_no: '', note: '' });
}
async function doScrap() {
  if (!scrapForm.scrap_no.trim()) return alert('必须填处置单号或财务回执号');
  if (!confirm(`确认处置「${scrapForm.item.name}」？处置后不能再发放。`)) return;
  try {
    await api.cuScrap(scrapForm.item.id, {
      scrap_mode: scrapForm.scrap_mode, scrap_no: scrapForm.scrap_no, note: scrapForm.note || undefined
    });
    scrapForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 详情 / 时间线 ---------------- */
async function openRecord(r) {
  try { recordDetail.value = await api.cuRecord(r.id); } catch (e) { alert(e.message); }
}
async function openTimeline(it) {
  try { timeline.value = await api.cuItemTimeline(it.id); } catch (e) { alert(e.message); }
}

/* ---------------- 清退 ---------------- */
const clearanceForm = reactive({ open: false, employee_id: null, leave_date: ymdLocal(), reason: '' });
function openClearance() {
  Object.assign(clearanceForm, { open: true, employee_id: null, leave_date: ymdLocal(), reason: '' });
}
async function doBuildClearance() {
  if (!clearanceForm.employee_id) return alert('请选择员工');
  try {
    const d = await api.cuBuildClearance({
      employee_id: clearanceForm.employee_id,
      leave_date: clearanceForm.leave_date || undefined,
      reason: clearanceForm.reason || undefined
    });
    clearanceForm.open = false;
    clearanceDetail.value = d;
    await reload();
  } catch (e) { alert(e.message); }
}
async function openClearanceDetail(c) {
  clearanceDetail.value = c;
}
async function openClearanceDetailById(id) {
  const list = await api.cuClearances({});
  clearanceDetail.value = (list || []).find((x) => x.id === id) || null;
}
async function doCloseClearance(c) {
  if (!confirm(`结案 ${c.clearance_no}？必须归还的实物都要先回来。`)) return;
  try {
    await api.cuCloseClearance(c.id, {});
    clearanceDetail.value = null;
    await reload();
  } catch (e) { alert(e.message); }
}

async function loadPerson() {
  if (!personId.value) return alert('请选择员工');
  try { person.value = await api.cuPerson(personId.value); } catch (e) { alert(e.message); }
}

/* ---------------- 复核 ---------------- */
const reviewForm = reactive({ open: false, claim: null, decision: 'partial', liable_pct: 50, reviewer_note: '' });
const previewAmount = computed(() => {
  const c = reviewForm.claim;
  if (!c) return '0.00';
  const pct = reviewForm.decision === 'cleared' ? 0 : (reviewForm.decision === 'liable' ? 100 : num(reviewForm.liable_pct));
  return money(num(c.claim_amount) * pct / 100);
});
function openReview(c) {
  Object.assign(reviewForm, { open: true, claim: c, decision: 'partial', liable_pct: 50, reviewer_note: '' });
}
async function doReview() {
  if (!reviewForm.reviewer_note.trim()) return alert('复核必须写依据');
  try {
    await api.cuReview(reviewForm.claim.id, {
      decision: reviewForm.decision,
      liable_pct: reviewForm.decision === 'partial' ? reviewForm.liable_pct : undefined,
      reviewer_note: reviewForm.reviewer_note
    });
    reviewForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

const financeForm = reactive({ open: false, claim: null, finance_confirm_no: '', finance_note: '' });
function openFinance(c) {
  Object.assign(financeForm, { open: true, claim: c, finance_confirm_no: '', finance_note: '' });
}
async function doFinance() {
  if (!financeForm.finance_confirm_no.trim()) return alert('必须填财务回执号');
  try {
    await api.cuFinance(financeForm.claim.id, {
      finance_confirm_no: financeForm.finance_confirm_no, finance_note: financeForm.finance_note || undefined
    });
    financeForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

const claimForm = reactive({ open: false, item_id: null, employee_id: null, damage_type: 'damaged', found_at: ymdLocal(), claim_amount: 0, desc_text: '' });
function openClaim() {
  Object.assign(claimForm, { open: true, item_id: null, employee_id: null, damage_type: 'damaged', found_at: ymdLocal(), claim_amount: 0, desc_text: '' });
}
async function doCreateClaim() {
  if (!claimForm.item_id || !claimForm.employee_id) return alert('请选择实物与责任人');
  if (!claimForm.desc_text.trim()) return alert('必须写清情况');
  try {
    await api.cuCreateClaim({
      item_id: claimForm.item_id, employee_id: claimForm.employee_id,
      damage_type: claimForm.damage_type, found_at: claimForm.found_at,
      claim_amount: claimForm.claim_amount || 0, desc_text: claimForm.desc_text
    });
    claimForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

onMounted(reload);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }
.panel .tag { white-space: nowrap; }

.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 100px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 12px; line-height: 1.4; }
.stat-card.warn { border-color: #fde68a; background: #fffdf5; }

.ell { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiny { font-size: 12px; line-height: 1.45; }
.mut { color: #7b8698; }
.red { color: #b91c1c; }
.amber-t { color: #92400e; }
.green-t { color: #047857; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.empty { padding: 26px 6px; color: #7b8698; font-size: 12.5px; }
.table-wrap { overflow-x: auto; }
table.data td { vertical-align: middle; }
table.data .tag { white-space: nowrap; }
table.data td b { white-space: nowrap; }
table.data .btn { white-space: nowrap; }
.ops { white-space: nowrap; }
.ops .btn + .btn { margin-left: 6px; }
.lnk { color: var(--brand); cursor: pointer; }

.notice { border: 1px solid #dbeafe; background: #f6faff; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #1e3a5f; margin-bottom: 10px; }
.notice-warn { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #92400e; margin-bottom: 10px; }
.hint-box { border: 1px solid #bbf7d0; background: #f5fdf8; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #14532d; margin-top: 10px; }

.modal.wide { width: min(1020px, 94vw); }
.mh-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.col-h { font-size: 12.5px; font-weight: 600; color: var(--ink); margin: 12px 0 6px; }
.kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.kv > span { color: #7b8698; min-width: 70px; flex: 0 0 auto; }
.kv > b { font-weight: 500; }

.row-line { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.person-box { border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 12px; }
.pb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; margin-bottom: 8px; }
.tl { border-left: 2px solid #eef1f6; padding-left: 10px; }
.tl-row { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; flex-wrap: wrap; }

.modal-body .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.modal-body .row label { font-size: 12px; color: #7b8698; flex: 0 0 auto; min-width: 62px; }
.modal-body .row label.ck { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.modal-body .row .btn { flex: 0 0 auto; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  /* .head-ops 全局是 flex:none，窄屏会按内容撑开、把「登记领用」挤出屏幕 ——
     这里强制让它换行并占满宽度，下拉各自占一半 */
  .page-head .head-ops,
  .panel-head .head-ops { width: 100%; flex: 1 1 auto; flex-wrap: wrap; }
  .panel-head .head-ops .select { flex: 1 1 45%; min-width: 0; max-width: 100%; }
  .panel-head .head-ops .btn { flex: 1 1 100%; }
  .page-head .head-ops .input { flex: 1 1 60%; min-width: 0; }
}
</style>
