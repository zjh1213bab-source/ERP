<template>
  <div>
    <div class="page-head">
      <div>
        <h2>质量与合规</h2>
        <div class="sub">检验计划 · 异常返修与纠正措施 · 批次追溯 · 童装合规 · 召回评估</div>
      </div>
      <button class="btn btn-ghost" @click="loadAll">刷新</button>
    </div>

    <div class="cards">
      <div class="stat-card">
        <div class="label">本月合格率</div>
        <div class="value">{{ s.pass_rate === null || s.pass_rate === undefined ? '—' : s.pass_rate }}<small v-if="s.pass_rate !== null && s.pass_rate !== undefined">%</small></div>
        <div class="delta">抽检 {{ s.month_sample || 0 }} 件 · 合格 {{ s.month_pass || 0 }} 件</div>
      </div>
      <div class="stat-card">
        <div class="label">待检单</div>
        <div class="value">{{ s.pending_inspections || 0 }}</div>
        <div class="delta">本月检验 {{ s.month_inspections || 0 }} 单</div>
      </div>
      <div class="stat-card" :class="s.critical_issues ? 'accent' : ''">
        <div class="label">未结异常</div>
        <div class="value">{{ s.open_issues || 0 }}</div>
        <div class="delta">其中致命 {{ s.critical_issues || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">冻结批次 / 召回</div>
        <div class="value">{{ s.hold_batches || 0 }}<small>/ {{ s.open_recalls || 0 }}</small></div>
        <div class="delta">标准 {{ s.standards || 0 }} 份</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="switchTab(t.key)">{{ t.label }}</button>
      </div>
    </div>

    <!-- ============ 检验单 ============ -->
    <template v-if="tab === 'inspections'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="f.type" @change="loadInspections">
          <option value="">全部类型</option>
          <option value="incoming">来料检验</option>
          <option value="process">过程检验</option>
          <option value="final">成品检验</option>
        </select>
        <select class="select" v-model="f.status" @change="loadInspections">
          <option value="">全部状态</option>
          <option value="draft">待检</option>
          <option value="done">已完成</option>
        </select>
        <input class="input" v-model="f.q" placeholder="检验单号 / 批次 / 款号" @keyup.enter="loadInspections" style="width: 220px" />
        <button class="btn btn-ghost" @click="loadInspections">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openInspectionForm">＋ 新建检验</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>检验单号</th><th>类型</th><th>订单</th><th>批次</th><th>标准</th>
              <th class="num">抽检</th><th class="num">合格</th><th class="num">不良</th>
              <th>判定</th><th>检验日期</th><th style="width: 160px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in inspections" :key="r.id">
              <td><strong>{{ r.inspect_no }}</strong></td>
              <td>{{ r.type_label }}</td>
              <td>{{ r.order_no || '-' }}</td>
              <td>{{ r.batch_no || '-' }}</td>
              <td>{{ r.standard_name || '-' }}</td>
              <td class="num">{{ r.sample_qty }}</td>
              <td class="num">{{ r.pass_qty }}</td>
              <td class="num">
                <span :class="r.fail_qty > 0 ? 'tag red' : 'muted'">{{ r.fail_qty }}</span>
              </td>
              <td>
                <span v-if="r.status === 'draft'" class="tag gray">待检</span>
                <span v-else class="tag" :class="r.aql_result === 'pass' ? 'green' : r.aql_result === 'conditional' ? 'orange' : 'red'">
                  {{ resultLabel(r.aql_result) }}
                </span>
              </td>
              <td>{{ r.inspect_date || '-' }}</td>
              <td style="white-space: nowrap">
                <button class="link-btn" @click="openInspection(r)">{{ r.status === 'draft' && canWrite ? '录入' : '查看' }}</button>
                <button v-if="r.status === 'draft' && canWrite" class="link-btn danger" @click="removeInspection(r)">删除</button>
                <button v-if="r.batch_no" class="link-btn" @click="openTrace(r.batch_no)">追溯</button>
                <button v-if="r.order_id" class="link-btn" @click="openReport(r.order_id)">验货报告</button>
              </td>
            </tr>
            <tr v-if="!inspections.length"><td colspan="11" class="empty-cell">暂无检验单，点「新建检验」按订单+标准开单</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 质量标准 ============ -->
    <template v-else-if="tab === 'standards'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="f.scope" @change="loadStandards">
          <option value="">全部环节</option>
          <option value="incoming">来料</option>
          <option value="process">过程</option>
          <option value="final">成品</option>
          <option value="child">童装合规</option>
        </select>
        <button class="btn btn-ghost" @click="loadStandards">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openStandardForm">＋ 新建标准</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>编号</th><th>标准名称</th><th>环节</th><th>品类</th><th>AQL</th><th class="num">检验项</th><th>状态</th><th v-if="canWrite" style="width: 140px">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in standards" :key="r.id">
              <td>{{ r.code || '-' }}</td>
              <td><strong>{{ r.name }}</strong></td>
              <td><span class="tag" :class="r.scope === 'child' ? 'purple' : 'blue'">{{ r.scope_label }}</span></td>
              <td>{{ r.category || '通用' }}</td>
              <td>{{ r.aql || '-' }}</td>
              <td class="num">{{ r.item_count }}</td>
              <td><span class="tag" :class="r.status === 'active' ? 'green' : 'gray'">{{ r.status === 'active' ? '启用' : '停用' }}</span></td>
              <td v-if="canWrite" style="white-space: nowrap">
                <button class="link-btn" @click="openStandardForm(r)">编辑</button>
                <button v-if="r.status === 'active'" class="link-btn danger" @click="disableStandard(r)">停用</button>
              </td>
            </tr>
            <tr v-if="!standards.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无标准</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 异常返修 ============ -->
    <template v-else-if="tab === 'issues'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="f.istatus" @change="loadIssues">
          <option value="">全部状态</option>
          <option value="open">待处理</option>
          <option value="processing">处理中</option>
          <option value="closed">已关闭</option>
        </select>
        <select class="select" v-model="f.isource" @change="loadIssues">
          <option value="">全部来源</option>
          <option value="inspection">检验</option>
          <option value="complaint">客诉</option>
          <option value="internal">内部</option>
          <option value="recall">召回</option>
        </select>
        <button class="btn btn-ghost" @click="loadIssues">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openIssueForm()">＋ 登记异常/客诉</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>异常单号</th><th>来源</th><th>类型</th><th>严重度</th><th>订单/批次</th>
              <th class="num">数量</th><th>问题描述</th><th>责任人</th><th>状态</th><th style="width: 130px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in issues" :key="r.id">
              <td><strong>{{ r.issue_no }}</strong></td>
              <td>{{ r.source_label }}</td>
              <td>{{ r.type_label }}</td>
              <td><span class="tag" :class="r.severity === 'critical' ? 'red' : r.severity === 'major' ? 'orange' : 'gray'">{{ severityLabel(r.severity) }}</span></td>
              <td>{{ r.order_no || '-' }}<div class="muted">{{ r.batch_no || '' }}</div></td>
              <td class="num">{{ r.qty }}</td>
              <td style="max-width: 260px">{{ r.description }}</td>
              <td>{{ r.owner || '-' }}</td>
              <td><span class="tag" :class="r.status === 'closed' ? 'green' : r.status === 'processing' ? 'blue' : 'orange'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" style="white-space: nowrap">
                <button class="link-btn" @click="openIssueForm(r)">处理</button>
                <button v-if="r.status !== 'closed'" class="link-btn" @click="closeIssue(r)">关闭</button>
              </td>
            </tr>
            <tr v-if="!issues.length"><td :colspan="10" class="empty-cell">暂无异常单</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 批次追溯 ============ -->
    <template v-else-if="tab === 'batches'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="f.bstatus" @change="loadBatches">
          <option value="">全部状态</option>
          <option value="normal">正常</option>
          <option value="hold">已冻结</option>
          <option value="recalled">已召回</option>
        </select>
        <input class="input" v-model="f.bq" placeholder="批次号 / 款号 / 面料批号" @keyup.enter="loadBatches" style="width: 240px" />
        <button class="btn btn-ghost" @click="loadBatches">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openBatchForm">＋ 新建批次</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>批次号</th><th>订单</th><th>客户</th><th>款号</th><th class="num">数量</th>
              <th>生产日期</th><th>工厂</th><th>面料批号</th><th>童装合规</th><th>状态</th><th style="width: 150px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in batches" :key="r.id">
              <td><strong>{{ r.batch_no }}</strong></td>
              <td>{{ r.order_no || '-' }}</td>
              <td>{{ r.customer_name || '-' }}</td>
              <td>{{ r.style_no || '-' }}</td>
              <td class="num">{{ r.qty }}</td>
              <td>{{ r.production_date || '-' }}</td>
              <td>{{ r.factory || '-' }}</td>
              <td>{{ r.fabric_batch || '-' }}</td>
              <td>{{ r.child_safety || '-' }}</td>
              <td><span class="tag" :class="r.status === 'normal' ? 'green' : r.status === 'hold' ? 'orange' : 'red'">{{ r.status_label }}</span></td>
              <td style="white-space: nowrap">
                <button class="link-btn" @click="openTrace(r.batch_no)">追溯</button>
                <button v-if="canWrite" class="link-btn" @click="openBatchForm(r)">编辑</button>
              </td>
            </tr>
            <tr v-if="!batches.length"><td colspan="11" class="empty-cell">暂无批次，成品检验合格后可建批次并追溯</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 召回 ============ -->
    <template v-else>
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="f.rstatus" @change="loadRecalls">
          <option value="">全部状态</option>
          <option value="assessing">评估中</option>
          <option value="confirmed">已确认</option>
          <option value="executing">执行中</option>
          <option value="closed">已结案</option>
        </select>
        <button class="btn btn-ghost" @click="loadRecalls">查询</button>
        <button v-if="canWrite" class="btn btn-danger" @click="openRecallForm">＋ 发起召回评估</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>召回单号</th><th>订单</th><th>客户</th><th>批次</th><th>原因</th>
              <th>严重度</th><th class="num">涉及</th><th class="num">已收回</th><th>进度</th><th>已通知客户</th><th style="width: 210px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in recalls" :key="r.id">
              <td><strong>{{ r.recall_no }}</strong></td>
              <td>{{ r.order_no || '-' }}</td>
              <td>{{ r.customer_name || '-' }}</td>
              <td>{{ r.batch_no || '-' }}</td>
              <td style="max-width: 220px">{{ r.reason }}</td>
              <td><span class="tag" :class="r.severity === 'critical' ? 'red' : 'orange'">{{ severityLabel(r.severity) }}</span></td>
              <td class="num">{{ r.qty_affected }}</td>
              <td class="num">{{ r.qty_recalled }}</td>
              <td><span class="tag" :class="r.status === 'closed' ? 'green' : 'orange'">{{ r.status_label }}</span></td>
              <td>{{ r.customer_notified ? '已通知' : '未通知' }}</td>
              <td v-if="canWrite" style="white-space: nowrap">
                <button class="link-btn" @click="openRecallForm(r)">更新</button>
                <button v-if="!r.customer_notified" class="link-btn" @click="notifyRecall(r)">通知客户</button>
              </td>
            </tr>
            <tr v-if="!recalls.length"><td colspan="11" class="empty-cell">暂无召回单</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ===== 新建检验 ===== -->
    <div v-if="inspForm" class="modal-mask" @click.self="inspForm = null">
      <div class="modal">
        <div class="modal-head">
          <h3>新建检验单</h3>
          <button class="x" @click="inspForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>订单 *</label>
              <select class="select" v-model.number="inspForm.order_id">
                <option :value="null">— 选择订单 —</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '-' }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>检验类型</label>
              <select class="select" v-model="inspForm.type">
                <option value="final">成品检验</option>
                <option value="process">过程检验</option>
                <option value="incoming">来料检验</option>
              </select>
            </div>
            <div class="fitem">
              <label>适用标准</label>
              <select class="select" v-model.number="inspForm.standard_id">
                <option :value="null">— 不套用标准 —</option>
                <option v-for="st in standards" :key="st.id" :value="st.id">{{ st.name }}（{{ st.item_count }} 项）</option>
              </select>
            </div>
            <div class="fitem"><label>批次号</label><input class="input" v-model="inspForm.batch_no" placeholder="可空，后续可补" /></div>
            <div class="fitem"><label>抽检数量</label><input class="input" type="number" v-model.number="inspForm.sample_qty" /></div>
            <div class="fitem"><label>检验日期</label><input class="input" type="date" v-model="inspForm.inspect_date" /></div>
            <div class="fitem full"><label>备注</label><textarea v-model="inspForm.remark" rows="2"></textarea></div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="inspForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveInspection">{{ saving ? '创建中…' : '创建并录入' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== 录入检验结果 ===== -->
    <div v-if="inspDetail" class="modal-mask" @click.self="inspDetail = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>检验录入 · {{ inspDetail.inspect_no }}</h3>
          <button class="x" @click="inspDetail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="muted" style="font-size: 12.5px; margin-bottom: 10px">
            {{ inspDetail.type_label }} · 订单 {{ inspDetail.order_no || '-' }} · 标准 {{ inspDetail.standard_name || '未套用' }}
            · 批次 {{ inspDetail.batch_no || '-' }}
          </div>
          <table class="data">
            <thead><tr><th style="width: 44px">#</th><th>检验项目</th><th>判定标准</th><th style="width: 150px">实测值</th><th style="width: 110px">结果</th><th style="width: 60px">致命</th></tr></thead>
            <tbody>
              <tr v-for="it in inspDetail.items" :key="it.id">
                <td>{{ it.seq }}</td>
                <td>{{ it.item_name }}</td>
                <td class="muted" style="font-size: 12px">{{ it.standard || '-' }}</td>
                <td><input class="input" v-model="it.actual" :disabled="!canEditInsp" /></td>
                <td>
                  <select class="select" v-model="it.result" :disabled="!canEditInsp">
                    <option value="ok">合格</option><option value="ng">不合格</option>
                  </select>
                </td>
                <td>{{ it.critical ? '是' : '否' }}</td>
              </tr>
              <tr v-if="!inspDetail.items.length">
                <td colspan="6" class="empty-cell">该检验单没有检验项，可直接填写抽检/不良数量后判定</td>
              </tr>
            </tbody>
          </table>
          <div class="form-grid" style="margin-top: 12px">
            <div class="fitem"><label>抽检数量</label><input class="input" type="number" v-model.number="inspDetail.sample_qty" :disabled="!canEditInsp" /></div>
            <div class="fitem"><label>不良数量</label><input class="input" type="number" v-model.number="inspDetail.fail_qty" :disabled="!canEditInsp" /></div>
            <div class="fitem full"><label>备注</label><textarea v-model="inspDetail.remark" rows="2" :disabled="!canEditInsp"></textarea></div>
          </div>
          <p v-if="inspDetail.aql_result" class="muted" style="font-size: 12px; margin: 8px 0 0">
            判定结果：<strong>{{ resultLabel(inspDetail.aql_result) }}</strong>
          </p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="inspDetail = null">关闭</button>
          <button v-if="canEditInsp" class="btn btn-ghost" :disabled="saving" @click="saveInsp(Draft)">保存</button>
          <button v-if="canEditInsp" class="btn btn-primary" :disabled="saving" @click="saveInsp('finish')">
            {{ saving ? '处理中…' : '保存并判定' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ===== 标准编辑 ===== -->
    <div v-if="stdForm" class="modal-mask" @click.self="stdForm = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ stdForm.id ? '编辑标准' : '新建质量标准' }}</h3>
          <button class="x" @click="stdForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>标准名称 *</label><input class="input" v-model="stdForm.name" /></div>
            <div class="fitem"><label>编号</label><input class="input" v-model="stdForm.code" /></div>
            <div class="fitem">
              <label>适用环节</label>
              <select class="select" v-model="stdForm.scope">
                <option value="final">成品</option><option value="process">过程</option>
                <option value="incoming">来料</option><option value="child">童装合规</option>
              </select>
            </div>
            <div class="fitem"><label>品类（空=通用）</label><input class="input" v-model="stdForm.category" /></div>
            <div class="fitem"><label>AQL</label><input class="input" v-model="stdForm.aql" placeholder="如 AQL 2.5" /></div>
            <div class="fitem"><label>状态</label>
              <select class="select" v-model="stdForm.status"><option value="active">启用</option><option value="disabled">停用</option></select>
            </div>
          </div>

          <h4 style="margin: 14px 0 8px; font-size: 14px">检验项目</h4>
          <table class="data">
            <thead><tr><th style="width: 46px">#</th><th style="width: 170px">项目</th><th>判定标准</th><th style="width: 150px">方法</th><th style="width: 60px">致命</th><th style="width: 46px"></th></tr></thead>
            <tbody>
              <tr v-for="(it, i) in stdForm.items" :key="i">
                <td>{{ i + 1 }}</td>
                <td><input class="input" v-model="it.item_name" /></td>
                <td><input class="input" v-model="it.standard" /></td>
                <td><input class="input" v-model="it.method" /></td>
                <td><input type="checkbox" v-model="it.critical" /></td>
                <td><button class="link-btn danger" @click="stdForm.items.splice(i, 1)">删</button></td>
              </tr>
              <tr v-if="!stdForm.items.length"><td colspan="6" class="empty-cell">还没有检验项</td></tr>
            </tbody>
          </table>
          <button class="btn btn-ghost btn-sm" style="margin-top: 8px" @click="stdForm.items.push({ item_name: '', standard: '', method: '', critical: false })">＋ 添加检验项</button>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="stdForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveStandard">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== 异常处理 ===== -->
    <div v-if="issueForm" class="modal-mask" @click.self="issueForm = null">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ issueForm.id ? '异常处理 · ' + issueForm.issue_no : '登记异常 / 客诉' }}</h3>
          <button class="x" @click="issueForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem" v-if="!issueForm.id">
              <label>来源</label>
              <select class="select" v-model="issueForm.source">
                <option value="complaint">客诉</option><option value="inspection">检验</option>
                <option value="internal">内部</option><option value="recall">召回</option>
              </select>
            </div>
            <div class="fitem">
              <label>处置类型</label>
              <select class="select" v-model="issueForm.type">
                <option value="rework">返修</option><option value="scrap">报废</option>
                <option value="concession">让步接收</option><option value="complaint">客诉</option>
              </select>
            </div>
            <div class="fitem">
              <label>严重度</label>
              <select class="select" v-model="issueForm.severity">
                <option value="minor">轻微</option><option value="major">重要</option><option value="critical">致命</option>
              </select>
            </div>
            <div class="fitem"><label>数量</label><input class="input" type="number" v-model.number="issueForm.qty" /></div>
            <div class="fitem" v-if="!issueForm.id">
              <label>订单</label>
              <select class="select" v-model.number="issueForm.order_id">
                <option :value="null">— 不关联 —</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }}</option>
              </select>
            </div>
            <div class="fitem"><label>批次号</label><input class="input" v-model="issueForm.batch_no" /></div>
            <div class="fitem"><label>责任人</label><input class="input" v-model="issueForm.owner" /></div>
            <div class="fitem"><label>要求完成日期</label><input class="input" type="date" v-model="issueForm.due_date" /></div>
            <div class="fitem full"><label>问题描述 *</label><textarea v-model="issueForm.description" rows="2"></textarea></div>
            <div class="fitem full"><label>根本原因</label><textarea v-model="issueForm.root_cause" rows="2" placeholder="如：面料批次色差 / 车缝工艺未按工艺卡执行"></textarea></div>
            <div class="fitem full"><label>纠正措施</label><textarea v-model="issueForm.action" rows="2" placeholder="如：全批返修并加严抽检，供应商下批提供色卡"></textarea></div>
            <div class="fitem" v-if="issueForm.id">
              <label>状态</label>
              <select class="select" v-model="issueForm.status">
                <option value="open">待处理</option><option value="processing">处理中</option><option value="closed">已关闭</option>
              </select>
            </div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="issueForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveIssue">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== 批次编辑 ===== -->
    <div v-if="batchForm" class="modal-mask" @click.self="batchForm = null">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ batchForm.id ? '编辑批次 · ' + batchForm.batch_no : '新建生产批次' }}</h3>
          <button class="x" @click="batchForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem" v-if="!batchForm.id">
              <label>订单</label>
              <select class="select" v-model.number="batchForm.order_id">
                <option :value="null">— 不关联 —</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '-' }}</option>
              </select>
            </div>
            <div class="fitem"><label>数量</label><input class="input" type="number" v-model.number="batchForm.qty" /></div>
            <div class="fitem"><label>生产日期</label><input class="input" type="date" v-model="batchForm.production_date" /></div>
            <div class="fitem"><label>工厂</label><input class="input" v-model="batchForm.factory" /></div>
            <div class="fitem"><label>面料批号（来料追溯）</label><input class="input" v-model="batchForm.fabric_batch" /></div>
            <div class="fitem"><label>童装安全类别</label><input class="input" v-model="batchForm.child_safety" placeholder="如 GB31701 A类" /></div>
            <div class="fitem">
              <label>批次状态</label>
              <select class="select" v-model="batchForm.status">
                <option value="normal">正常</option><option value="hold">冻结</option><option value="recalled">已召回</option>
              </select>
            </div>
            <div class="fitem full"><label>备注</label><textarea v-model="batchForm.remark" rows="2"></textarea></div>
          </div>

          <h4 style="margin: 14px 0 8px; font-size: 14px">合规资料（童装必备）</h4>
          <table class="data">
            <thead><tr><th style="width: 170px">资料类型</th><th>编号</th><th style="width: 170px">出具机构</th><th style="width: 160px">有效期至</th><th style="width: 46px"></th></tr></thead>
            <tbody>
              <tr v-for="(d, i) in batchForm.docs" :key="i">
                <td>
                  <select class="select" v-model="d.doc_type">
                    <option value="检测报告">检测报告</option><option value="安全类别">安全类别</option>
                    <option value="成分标识">成分标识</option><option value="3C认证">3C 认证</option><option value="其他">其他</option>
                  </select>
                </td>
                <td><input class="input" v-model="d.doc_no" /></td>
                <td><input class="input" v-model="d.issued_by" /></td>
                <td><input class="input" type="date" v-model="d.valid_until" /></td>
                <td><button class="link-btn danger" @click="batchForm.docs.splice(i, 1)">删</button></td>
              </tr>
              <tr v-if="!batchForm.docs.length"><td colspan="5" class="empty-cell">还没有合规资料</td></tr>
            </tbody>
          </table>
          <button class="btn btn-ghost btn-sm" style="margin-top: 8px"
            @click="batchForm.docs.push({ doc_type: '检测报告', doc_no: '', issued_by: '', valid_until: '' })">＋ 添加资料</button>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="batchForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveBatch">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== 追溯 ===== -->
    <div v-if="trace" class="modal-mask" @click.self="trace = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>批次追溯 · {{ trace.batch.batch_no }}</h3>
          <button class="x" @click="trace = null">×</button>
        </div>
        <div class="modal-body">
          <table class="data" style="margin-bottom: 12px">
            <tbody>
              <tr><th style="width: 110px">订单</th><td>{{ trace.order ? trace.order.order_no : '-' }}</td>
                <th style="width: 110px">客户</th><td>{{ trace.order ? trace.order.customer_name : '-' }}</td></tr>
              <tr><th>款号 / 品名</th><td>{{ trace.batch.style_no || '-' }} / {{ trace.batch.product_name || '-' }}</td>
                <th>数量</th><td>{{ trace.batch.qty }}</td></tr>
              <tr><th>生产日期</th><td>{{ trace.batch.production_date || '-' }}</td>
                <th>工厂</th><td>{{ trace.batch.factory || '-' }}</td></tr>
              <tr><th>面料批号</th><td>{{ trace.batch.fabric_batch || '-' }}</td>
                <th>童装合规</th><td>{{ trace.batch.child_safety || '-' }}</td></tr>
              <tr><th>批次状态</th><td colspan="3">
                <span class="tag" :class="trace.batch.status === 'normal' ? 'green' : trace.batch.status === 'hold' ? 'orange' : 'red'">{{ trace.batch.status_label }}</span>
              </td></tr>
            </tbody>
          </table>

          <h4 class="tr-h">合规资料</h4>
          <table class="data">
            <thead><tr><th>类型</th><th>编号</th><th>出具机构</th><th>有效期至</th></tr></thead>
            <tbody>
              <tr v-for="(d, i) in trace.batch.docs" :key="i">
                <td>{{ d.doc_type }}</td><td>{{ d.doc_no || '-' }}</td><td>{{ d.issued_by || '-' }}</td><td>{{ d.valid_until || '-' }}</td>
              </tr>
              <tr v-if="!trace.batch.docs.length"><td colspan="4" class="empty-cell">未登记合规资料</td></tr>
            </tbody>
          </table>

          <h4 class="tr-h">检验记录（{{ trace.inspections.length }}）</h4>
          <table class="data">
            <thead><tr><th>检验单号</th><th>类型</th><th class="num">抽检</th><th class="num">不良</th><th>判定</th><th>日期</th></tr></thead>
            <tbody>
              <tr v-for="r in trace.inspections" :key="r.id">
                <td>{{ r.inspect_no }}</td><td>{{ r.type_label }}</td>
                <td class="num">{{ r.sample_qty }}</td><td class="num">{{ r.fail_qty }}</td>
                <td><span class="tag" :class="r.aql_result === 'pass' ? 'green' : r.aql_result === 'conditional' ? 'orange' : 'red'">{{ resultLabel(r.aql_result) }}</span></td>
                <td>{{ r.inspect_date }}</td>
              </tr>
              <tr v-if="!trace.inspections.length"><td colspan="6" class="empty-cell">无检验记录</td></tr>
            </tbody>
          </table>

          <h4 class="tr-h">异常与纠正措施（{{ trace.issues.length }}）</h4>
          <table class="data">
            <thead><tr><th>异常单号</th><th>类型</th><th>严重度</th><th class="num">数量</th><th>描述</th><th>措施</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="r in trace.issues" :key="r.id">
                <td>{{ r.issue_no }}</td><td>{{ r.type_label }}</td>
                <td><span class="tag" :class="r.severity === 'critical' ? 'red' : 'orange'">{{ severityLabel(r.severity) }}</span></td>
                <td class="num">{{ r.qty }}</td><td>{{ r.description }}</td><td>{{ r.action || '-' }}</td>
                <td>{{ r.status_label }}</td>
              </tr>
              <tr v-if="!trace.issues.length"><td colspan="7" class="empty-cell">无异常记录</td></tr>
            </tbody>
          </table>

          <h4 class="tr-h">召回记录（{{ trace.recalls.length }}）</h4>
          <table class="data">
            <thead><tr><th>召回单号</th><th>原因</th><th class="num">涉及</th><th class="num">已收回</th><th>进度</th></tr></thead>
            <tbody>
              <tr v-for="r in trace.recalls" :key="r.id">
                <td>{{ r.recall_no }}</td><td>{{ r.reason }}</td>
                <td class="num">{{ r.qty_affected }}</td><td class="num">{{ r.qty_recalled }}</td><td>{{ r.status_label }}</td>
              </tr>
              <tr v-if="!trace.recalls.length"><td colspan="5" class="empty-cell">无召回记录</td></tr>
            </tbody>
          </table>

          <h4 class="tr-h">出入库流水（{{ trace.ledger.length }}）</h4>
          <table class="data">
            <thead><tr><th>时间</th><th>仓库</th><th>类型</th><th class="num">数量</th><th>操作人</th><th>备注</th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in trace.ledger" :key="i">
                <td>{{ (l.created_at || '').replace('T', ' ').slice(0, 16) }}</td>
                <td>{{ l.warehouse === 'cn' ? '生产仓' : '美仓' }}</td>
                <td>{{ l.type }}</td><td class="num">{{ l.qty }}</td>
                <td>{{ l.operator || '-' }}</td><td>{{ l.remark || '-' }}</td>
              </tr>
              <tr v-if="!trace.ledger.length"><td colspan="6" class="empty-cell">无出入库记录</td></tr>
            </tbody>
          </table>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="trace = null">关闭</button></div>
      </div>
    </div>

    <!-- ===== 召回 ===== -->
    <div v-if="recallForm" class="modal-mask" @click.self="recallForm = null">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ recallForm.id ? '更新召回 · ' + recallForm.recall_no : '发起召回评估' }}</h3>
          <button class="x" @click="recallForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid" v-if="!recallForm.id">
            <div class="fitem full">
              <label>批次 *</label>
              <select class="select" v-model="recallForm.batch_no">
                <option value="">— 选择批次 —</option>
                <option v-for="b in batches" :key="b.id" :value="b.batch_no">
                  {{ b.batch_no }} · {{ b.order_no || '-' }} · {{ b.style_no || '' }}
                </option>
              </select>
            </div>
            <div class="fitem">
              <label>严重度</label>
              <select class="select" v-model="recallForm.severity">
                <option value="minor">轻微</option><option value="major">重要</option><option value="critical">致命</option>
              </select>
            </div>
            <div class="fitem"><label>涉及数量</label><input class="input" type="number" v-model.number="recallForm.qty_affected" /></div>
          </div>
          <div class="form-grid" v-else>
            <div class="fitem">
              <label>进度</label>
              <select class="select" v-model="recallForm.status">
                <option value="assessing">评估中</option><option value="confirmed">已确认</option>
                <option value="executing">执行中</option><option value="closed">已结案</option>
              </select>
            </div>
            <div class="fitem"><label>已收回数量</label><input class="input" type="number" v-model.number="recallForm.qty_recalled" /></div>
            <div class="fitem">
              <label>严重度</label>
              <select class="select" v-model="recallForm.severity">
                <option value="minor">轻微</option><option value="major">重要</option><option value="critical">致命</option>
              </select>
            </div>
          </div>
          <div class="fitem"><label>召回原因 *</label><textarea v-model="recallForm.reason" rows="2"></textarea></div>
          <div class="fitem"><label>备注</label><textarea v-model="recallForm.remark" rows="2"></textarea></div>
          <p class="muted" style="font-size: 12px; margin: 8px 0 0">
            发起后该批次会自动置为「冻结」，避免继续出库；结案后置为「已召回」。
          </p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="recallForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveRecall">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'inspections', label: '检验单' },
  { key: 'standards', label: '质量标准' },
  { key: 'issues', label: '异常返修' },
  { key: 'batches', label: '批次追溯' },
  { key: 'recalls', label: '召回评估' }
];
const router = useRouter();
const canWrite = computed(() => can('qc.write'));

const tab = ref('inspections');
const s = reactive({});
const f = reactive({ type: '', status: '', q: '', scope: '', istatus: '', isource: '', bstatus: '', bq: '', rstatus: '' });

const inspections = ref([]);
const standards = ref([]);
const issues = ref([]);
const batches = ref([]);
const recalls = ref([]);
const orders = ref([]);

const inspForm = ref(null);
const inspDetail = ref(null);
const stdForm = ref(null);
const issueForm = ref(null);
const batchForm = ref(null);
const recallForm = ref(null);
const trace = ref(null);
const saving = ref(false);
const formMsg = ref('');

const resultLabel = (v) => ({ pass: '合格', fail: '不合格', conditional: '让步接收' }[v] || (v || '-'));
const severityLabel = (v) => ({ critical: '致命', major: '重要', minor: '轻微' }[v] || v);
const Draft = 'draft';
const canEditInsp = computed(() => {
  const d = inspDetail.value;
  return !!(d && d.status === 'draft' && canWrite.value);
});

async function loadStats() { try { Object.assign(s, await api.qcStats()); } catch (e) { /* ignore */ } }
/** 验货报告：按这张检验单所属订单出报告（报告是整单的，不是单张检验单的） */
function openReport(orderId) {
  router.push('/inspection/' + orderId);
}

async function loadInspections() { try { inspections.value = await api.qcInspections({ type: f.type, status: f.status, q: f.q }); } catch (e) { alert(e.message); } }
async function loadStandards() { try { standards.value = await api.qcStandards({ scope: f.scope }); } catch (e) { alert(e.message); } }
async function loadIssues() { try { issues.value = await api.qcIssues({ status: f.istatus, source: f.isource }); } catch (e) { alert(e.message); } }
async function loadBatches() { try { batches.value = await api.qcBatches({ status: f.bstatus, q: f.bq }); } catch (e) { alert(e.message); } }
async function loadRecalls() { try { recalls.value = await api.qcRecalls({ status: f.rstatus }); } catch (e) { alert(e.message); } }
async function loadOrders() {
  try { orders.value = await api.orders({}); } catch (e) { /* ignore */ }
}
async function loadAll() {
  await Promise.all([loadStats(), loadInspections(), loadStandards(), loadIssues(), loadBatches(), loadRecalls(), loadOrders()]);
}
function switchTab(k) { tab.value = k; }

// ---- 检验 ----
function openInspectionForm() {
  formMsg.value = '';
  inspForm.value = {
    order_id: null, type: 'final', standard_id: null, batch_no: '',
    sample_qty: 0, inspect_date: new Date().toISOString().slice(0, 10), remark: ''
  };
}
async function saveInspection() {
  formMsg.value = '';
  if (!inspForm.value.order_id) { formMsg.value = '请选择订单'; return; }
  saving.value = true;
  try {
    const r = await api.createQcInspection(inspForm.value);
    inspForm.value = null;
    await loadInspections();
    await loadStats();
    inspDetail.value = r;
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function openInspection(r) {
  formMsg.value = '';
  try { inspDetail.value = await api.qcInspection(r.id); } catch (e) { alert(e.message); }
}
async function saveInsp(mode) {
  formMsg.value = '';
  const d = inspDetail.value;
  saving.value = true;
  try {
    await api.updateQcInspection(d.id, {
      items: d.items.map((it) => ({ id: it.id, actual: it.actual, result: it.result, remark: it.remark })),
      sample_qty: Number(d.sample_qty) || 0,
      fail_qty: Number(d.fail_qty) || 0,
      batch_no: d.batch_no || null,
      remark: d.remark || null
    });
    if (mode === 'finish') {
      const done = await api.finishQcInspection(d.id, {});
      inspDetail.value = done;
      await loadInspections();
      await loadStats();
      if (done.issue_id) {
        await loadIssues();
        alert(`检验判定：${resultLabel(done.aql_result)}\n已自动生成异常单，请到「异常返修」跟进。`);
      }
    } else {
      inspDetail.value = await api.qcInspection(d.id);
      await loadInspections();
    }
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function removeInspection(r) {
  if (!confirm(`删除检验单 ${r.inspect_no}？`)) return;
  try { await api.deleteQcInspection(r.id); await loadInspections(); await loadStats(); } catch (e) { alert(e.message); }
}

// ---- 标准 ----
async function openStandardForm(r) {
  formMsg.value = '';
  if (r) {
    const d = await api.qcStandard(r.id);
    stdForm.value = { ...d, items: d.items.map((it) => ({ item_name: it.item_name, standard: it.standard, method: it.method, critical: !!it.critical })) };
  } else {
    stdForm.value = { id: null, code: '', name: '', category: '', scope: 'final', aql: 'AQL 2.5', status: 'active', items: [{ item_name: '', standard: '', method: '', critical: false }] };
  }
}
async function saveStandard() {
  formMsg.value = '';
  if (!stdForm.value.name) { formMsg.value = '标准名称必填'; return; }
  saving.value = true;
  try {
    if (stdForm.value.id) await api.updateQcStandard(stdForm.value.id, stdForm.value);
    else await api.createQcStandard(stdForm.value);
    stdForm.value = null;
    await loadStandards();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function disableStandard(r) {
  if (!confirm(`停用标准「${r.name}」？`)) return;
  try { await api.deleteQcStandard(r.id); await loadStandards(); await loadStats(); } catch (e) { alert(e.message); }
}

// ---- 异常 ----
function openIssueForm(r) {
  formMsg.value = '';
  issueForm.value = r
    ? { ...r }
    : { id: null, source: 'complaint', type: 'complaint', severity: 'major', qty: 0, order_id: null,
        batch_no: '', description: '', root_cause: '', action: '', owner: '', due_date: '' };
}
async function saveIssue() {
  formMsg.value = '';
  if (!issueForm.value.description) { formMsg.value = '请填写问题描述'; return; }
  saving.value = true;
  try {
    if (issueForm.value.id) await api.updateQcIssue(issueForm.value.id, issueForm.value);
    else await api.createQcIssue(issueForm.value);
    issueForm.value = null;
    await loadIssues();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function closeIssue(r) {
  const action = prompt(`关闭 ${r.issue_no}，请填写纠正措施（可留空沿用原记录）：`, r.action || '');
  if (action === null) return;
  try { await api.closeQcIssue(r.id, { action }); await loadIssues(); await loadStats(); } catch (e) { alert(e.message); }
}

// ---- 批次 ----
async function openBatchForm(r) {
  formMsg.value = '';
  if (r) {
    batchForm.value = { ...r, docs: r.docs ? JSON.parse(r.docs) : [] };
  } else {
    batchForm.value = { id: null, order_id: null, qty: 0, production_date: new Date().toISOString().slice(0, 10),
      factory: '', fabric_batch: '', child_safety: '', status: 'normal', remark: '', docs: [] };
  }
}
async function saveBatch() {
  formMsg.value = '';
  saving.value = true;
  try {
    if (batchForm.value.id) await api.updateQcBatch(batchForm.value.id, batchForm.value);
    else await api.createQcBatch(batchForm.value);
    batchForm.value = null;
    await loadBatches();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function openTrace(batchNo) {
  try { trace.value = await api.qcTrace(batchNo); } catch (e) { alert(e.message); }
}

// ---- 召回 ----
function openRecallForm(r) {
  formMsg.value = '';
  recallForm.value = r
    ? { ...r }
    : { id: null, batch_no: '', severity: 'major', qty_affected: 0, reason: '', remark: '' };
}
async function saveRecall() {
  formMsg.value = '';
  if (!recallForm.value.reason) { formMsg.value = '请填写召回原因'; return; }
  if (!recallForm.value.id && !recallForm.value.batch_no) { formMsg.value = '请选择批次'; return; }
  saving.value = true;
  try {
    if (recallForm.value.id) await api.updateQcRecall(recallForm.value.id, recallForm.value);
    else await api.createQcRecall(recallForm.value);
    recallForm.value = null;
    await loadRecalls();
    await loadBatches();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function notifyRecall(r) {
  if (!confirm(`给客户发质量通知（${r.recall_no}）？将发送到客户商城站内信。`)) return;
  try {
    await api.notifyQcRecall(r.id);
    await loadRecalls();
    alert('已发送');
  } catch (e) { alert(e.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.delta { font-size: 12px; color: #8a94a6; margin-top: 8px; }
.tr-h { margin: 14px 0 8px; font-size: 13.5px; color: #16233b; }
.table-wrap { overflow-x: auto; }
</style>
