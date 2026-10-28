<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>AI 能力中心</h2>
        <p class="sub">
          模型层只做<b>「整理」与「解释」</b>，不做决定：所有产出都是<b>草稿</b>，需要人核准才生效；
          <b>付款、工资、出厂价、质检判定、跨货调整一律不允许 AI 执行</b>。
          越权问题在调模型之前就被<b>权限守卫</b>拦掉，不靠提示词约束模型。
        </p>
      </div>
      <div class="head-ops">
        <span class="mode-pill" :class="mode === 'ai' ? 'mp-ai' : 'mp-rule'">
          {{ ov.mode_label || '检测中…' }}
        </span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div v-if="mode !== 'ai'" class="hint-bar">
      当前没有可用模型（未配置密钥或已停用），全部功能按<b>确定性规则</b>运行 —— 结论仍然来自真实数据，
      只是没有语言润色。配好密钥并在下方「模型网关」启用后，会自动切换为模型作答。
    </div>

    <div class="stat-row">
      <div class="stat" :class="ov.risk && ov.risk.stat && ov.risk.stat.high ? 'st-bad' : ''">
        <span>高风险事项</span>
        <strong>{{ (ov.risk && ov.risk.stat && ov.risk.stat.high) || 0 }}</strong>
        <small>中 {{ (ov.risk && ov.risk.stat && ov.risk.stat.mid) || 0 }} · 低 {{ (ov.risk && ov.risk.stat && ov.risk.stat.low) || 0 }}</small>
      </div>
      <div class="stat" :class="ov.drafts ? 'st-warn' : ''">
        <span>待核准草稿</span><strong>{{ ov.drafts || 0 }}</strong><small>AI 产出需人工核准</small>
      </div>
      <div class="stat" :class="lastEval && lastEval.leak_cnt ? 'st-bad' : lastEval ? 'st-good' : ''">
        <span>评测门禁</span>
        <strong>{{ lastEval ? (lastEval.leak_cnt ? '拦住' : '通过') : '未跑' }}</strong>
        <small>{{ lastEval ? `${lastEval.passed}/${lastEval.total} · 泄漏 ${lastEval.leak_cnt}` : '建议先跑一次' }}</small>
      </div>
      <div class="stat"><span>本月调用成本</span><strong>{{ fmt(ov.total_cost) }}</strong><small>今日 {{ ov.today_calls || 0 }} 次 · {{ fmt(ov.today_cost) }}</small></div>
      <div class="stat"><span>人工接管中</span><strong>{{ ov.handover_open || 0 }}</strong><small>已批准 FAQ {{ ov.faq_approved || 0 }} 条</small></div>
      <div class="stat"><span>周报</span><strong>{{ ov.weekly || 0 }}</strong><small>份（含草稿）</small></div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="go(t.k)">
          {{ t.label }}<span v-if="t.dot" class="tab-dot">{{ t.dot }}</span>
        </button>
      </div>
    </div>

    <!-- ========== 制度问答（N17-02） ========== -->
    <div v-if="tab === 'policy'" class="block">
      <div class="hint-bar">
        制度问题<b>不允许模型凭印象答</b>。这里的做法是：只检索<b>现行有效</b>版本 → 只从原文里切句子 → 引用行（文号 / 版本 / 生效日期 / 责任人）<b>由服务端拼</b>。
        草稿与已废止的制度一律不作为依据；查不到就直说查不到，不给「大致是」的答案。
      </div>

      <div class="pq-bar">
        <input v-model="pq" class="input" placeholder="问制度：请假 3 天谁批？出差住宿标准？付款 30 万谁审？"
          @keyup.enter="askPolicy()" />
        <button class="btn btn-primary" :disabled="pLoading || !pq.trim()" @click="askPolicy()">
          {{ pLoading ? '检索中…' : '问一下' }}
        </button>
      </div>
      <div class="pq-chips">
        <span class="muted tiny">试试：</span>
        <button v-for="q in sampleQ" :key="q" class="chip" @click="askPolicy(q)">{{ q }}</button>
      </div>

      <div v-if="pResult" class="pw-result">
        <div class="pw-head">
          <span class="pill" :class="pResult.answerable ? (pResult.confidence === 'high' ? 'p-green' : 'p-orange') : 'p-red'">
            {{ pResult.answerable ? (pResult.confidence === 'high' ? '命中现行制度' : '命中，覆盖度一般') : '没有可引用的生效制度' }}
          </span>
          <span class="muted tiny">
            作答：{{ pResult.generated_by === 'model' ? '模型串接（仅原文）' : '规则摘录' }}
            <template v-if="pResult.as_of"> · 截至 {{ pResult.as_of }}</template>
            <template v-if="pResult.logged"> · 留痕 {{ pResult.logged.saved }} 条</template>
          </span>
          <div class="spacer"></div>
          <span v-if="!pResult.answerable" class="tiny red">按规矩这次不该给答案</span>
        </div>

        <pre class="pw-answer">{{ pResult.answer }}</pre>

        <div v-if="pResult.citations.length" class="pw-cites">
          <div v-for="c in pResult.citations" :key="c.doc_no" class="cite">
            <div class="cite-top">
              <b>《{{ c.title }}》V{{ c.version }}</b>
              <span class="pill p-blue">{{ c.category_label }}</span>
              <span v-if="!c.citable" class="pill p-red">缺版本或生效日，不可引用</span>
              <div class="spacer"></div>
              <button class="link-btn" @click="openPolicyDoc(c.doc_no)">看原文</button>
            </div>
            <div class="cite-meta">
              <span>文号 <b class="mono">{{ c.doc_no }}</b></span>
              <span>生效日 <b>{{ c.effective_date || '未填' }}</b></span>
              <span>责任人 {{ c.owner || '未指定' }}</span>
              <span v-if="c.position">适用 {{ c.position }}</span>
              <span>覆盖度 {{ c.coverage }}%</span>
            </div>
          </div>
        </div>

        <div v-if="pResult.basis.length" class="pw-basis">
          <h4>原文摘录<small>以下是从制度原文切的句子，不是模型改写的</small></h4>
          <div v-for="(b, i) in pResult.basis" :key="i" class="basis-row">
            <span class="pill p-gray">{{ b.field }}</span>
            <span class="basis-text">{{ b.text }}</span>
            <span class="tiny muted mono">《{{ b.title }}》V{{ b.version }}</span>
          </div>
        </div>

        <div v-if="!pResult.answerable" class="pw-blocked">
          <div v-if="pResult.invalid.length">
            <b>相关制度目前不能引用：</b>
            <div v-for="x in pResult.invalid" :key="x.doc_no + x.version" class="inv-row">
              <span class="pill" :class="x.status === 'retired' ? 'p-red' : 'p-orange'">{{ x.status_label }}</span>
              《{{ x.title }}》{{ x.version ? 'V' + x.version : '（无版本）' }}
              <span v-if="x.effective_date" class="tiny muted">原生效 {{ x.effective_date }}</span>
              <span v-if="x.retire_reason" class="tiny muted">· {{ x.retire_reason }}</span>
            </div>
          </div>
          <div v-if="pResult.weak.length" class="tiny muted" style="margin-top: 8px">
            沾边但不够具体：{{ pResult.weak.map((x) => '《' + x.title + '》V' + x.version).join('、') }}
          </div>
        </div>
      </div>

      <h4 style="margin-top: 20px">现行有效制度<small>点开看原文与版本变更；这里只列 effective</small></h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 210px">制度</th><th style="width: 90px">类别</th><th style="width: 74px">版本</th>
            <th style="width: 106px">生效日</th><th style="width: 100px">责任人</th><th style="width: 80px">适用范围</th>
            <th class="num" style="width: 70px">版本数</th><th style="width: 80px">操作</th></tr></thead>
          <tbody>
            <tr v-for="d in pRecent" :key="d.doc_no">
              <td class="tiny"><b>{{ d.title }}</b><div class="muted mono">{{ d.doc_no }}</div></td>
              <td class="tiny">{{ d.category_label }}</td>
              <td><span class="pill p-blue">V{{ d.version }}</span></td>
              <td class="tiny mono">{{ d.effective_date || '—' }}</td>
              <td class="tiny">{{ d.owner || '—' }}</td>
              <td class="tiny">{{ d.position || '全岗位' }}</td>
              <td class="num tiny">{{ d.version_cnt }}</td>
              <td><button class="btn btn-ghost btn-sm" @click="openPolicyDoc(d.doc_no)">原文</button></td>
            </tr>
            <tr v-if="!pRecent.length"><td colspan="8" class="empty">还没有生效的制度，先去「流程与制度」发布</td></tr>
          </tbody>
        </table>
      </div>

      <h4 style="margin-top: 18px">引用留痕<small>制度改版后，这里能看出哪些回答当时引的是旧版</small></h4>
      <div class="toolbar" style="margin-bottom: 8px">
        <label class="chk"><input v-model="pOnlyOutdated" type="checkbox" /> 只看引用了旧版的</label>
        <span class="muted tiny">共 {{ pHits.rows.length }} 条，其中旧版 {{ pHits.outdated }} 条 —— 引了旧版的回答要回访更正</span>
      </div>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 120px">时间</th><th>问题</th><th style="width: 200px">引用的制度</th>
            <th style="width: 80px">版本</th><th style="width: 100px">当时生效日</th>
            <th style="width: 90px">状态</th><th style="width: 84px">提问人</th></tr></thead>
          <tbody>
            <tr v-for="h in pHitsView" :key="h.id">
              <td class="tiny mono">{{ $fmt(h.created_at) }}</td>
              <td class="tiny wrap">{{ h.question }}</td>
              <td class="tiny">{{ h.title }}<div class="muted mono">{{ h.doc_no }}</div></td>
              <td class="tiny">V{{ h.version }}<span v-if="h.outdated" class="tiny red"> → V{{ h.current_version }}</span></td>
              <td class="tiny mono">{{ h.effective_date || '—' }}</td>
              <td>
                <span class="pill" :class="h.outdated ? 'p-red' : 'p-green'">{{ h.outdated ? '已过期' : '现行' }}</span>
              </td>
              <td class="tiny">{{ h.actor }}</td>
            </tr>
            <tr v-if="!pHitsView.length"><td colspan="7" class="empty">还没有引用记录</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tiny muted" style="margin-top: 8px">{{ pHits.note }}</p>
    </div>

    <!-- ========== 1. 模型网关 ========== -->
    <div v-if="tab === 'gateway'" class="block">
      <h4>供应商与就绪状态<small>密钥只读环境变量，数据库里不保存明文；数据级别决定它能碰什么</small></h4>
      <div class="prov-grid">
        <div v-for="p in ov.providers" :key="p.id" class="prov-card" :class="'pc-' + p.status">
          <div class="pc-head">
            <b>{{ p.code }}</b>
            <span class="pill" :class="p.status === 'enabled' ? 'p-green' : p.status === 'disabled' ? 'p-gray' : 'p-orange'">{{ p.status_label }}</span>
          </div>
          <div class="pc-name">{{ p.name }}</div>
          <div class="pc-row"><span>模型</span><b class="mono">{{ p.model || '—' }}</b></div>
          <div class="pc-row"><span>数据级别</span><b>{{ scopeLabel(p.data_scope) }}</b></div>
          <div class="pc-row"><span>密钥</span><b :class="p.has_key ? 'amt-green' : 'amt-red'">{{ p.has_key ? '已配置 ' + p.key_masked : '未配置（' + p.key_env + '）' }}</b></div>
          <div class="pc-row"><span>本月预算</span><b>{{ fmt(p.used_amount) }} / {{ fmt(p.monthly_budget) }}</b></div>
          <div class="bar"><i :style="{ width: p.used_pct + '%' }" :class="p.used_pct > 85 ? 'bar-bad' : ''"></i></div>
          <div class="pc-note">{{ p.note }}</div>
          <div v-if="p.blocked_reason" class="pc-block">不可用：{{ p.blocked_reason }}</div>
          <div class="pc-ops">
            <button class="btn btn-ghost btn-sm" @click="testProvider(p)">连通测试</button>
            <button v-if="isAdmin" class="btn btn-ghost btn-sm"
              @click="toggleProvider(p)">{{ p.status === 'enabled' ? '停用' : '启用' }}</button>
          </div>
        </div>
      </div>

      <div class="hint-bar" style="margin-top: 12px">
        <b>数据分级路由规则：</b>公开 &lt; 内部 &lt; 受限。周报与绩效解释属<b>受限</b>级，只能由标记为受限的境内供应商处理；
        境外模型即使配了密钥，也拿不到薪资与绩效数据。这就是「按数据政策路由」的落地方式。
      </div>

      <h4 style="margin-top: 18px">调用审计<small>每次调用都留痕：谁问的、走的哪个供应商、花了多少、为什么降级</small></h4>
      <div class="toolbar">
        <select v-model="callFilter" @change="loadCalls">
          <option value="">全部状态</option>
          <option value="ok">模型作答</option>
          <option value="fallback">规则降级</option>
          <option value="blocked">已拦截</option>
          <option value="error">调用失败</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead>
            <tr>
              <th style="width: 140px">时间</th><th style="width: 110px">场景</th><th style="width: 90px">操作人</th>
              <th style="width: 120px">供应商</th><th style="width: 96px">状态</th>
              <th style="width: 80px" class="num">耗时</th><th style="width: 90px" class="num">费用</th><th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in calls" :key="c.id">
              <td class="tiny mono">{{ $fmt(c.created_at) }}</td>
              <td class="tiny">{{ c.scene_label }}</td>
              <td class="tiny">{{ c.actor || '—' }}</td>
              <td class="tiny mono">{{ c.provider_code || '—' }}</td>
              <td>
                <span class="pill" :class="c.status === 'ok' ? 'p-green' : c.status === 'blocked' ? 'p-red' : c.status === 'error' ? 'p-red' : 'p-orange'">{{ c.status_label }}</span>
              </td>
              <td class="num tiny">{{ c.latency_ms }}ms</td>
              <td class="num tiny">{{ c.cost ? fmt(c.cost) : '—' }}</td>
              <td class="tiny wrap">{{ c.reason || '—' }}</td>
            </tr>
            <tr v-if="!calls.length"><td colspan="8" class="empty">还没有调用记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 2. 需求抽取 ========== -->
    <div v-if="tab === 'extract'" class="block">
      <div class="split">
        <div class="split-l">
          <h4>粘贴询价 / 需求原文<small>邮件、微信、Excel 里的话都行，直接贴</small></h4>
          <textarea v-model="extractText" rows="12" placeholder="例：你好，我们要订一批卫衣。款号 HS-2026-08，320gsm 棉质毛圈，黑色和藏青，S/100 M/200 L/200 共 500 件，做旧水洗+绣花，单价 7.8 美金 FOB 宁波，交期 2026-12-15。"></textarea>
          <div class="form-row">
            <input v-model="extractLabel" placeholder="来源（可选）：客户名 / 邮件主题" />
            <button class="btn btn-primary" :disabled="extracting || extractText.trim().length < 10" @click="doExtract">
              {{ extracting ? '抽取中…' : '抽取' }}
            </button>
          </div>
          <div v-if="extractErr" class="err-bar">{{ extractErr }}</div>
          <div class="hint-bar" style="margin-top: 10px">
            抽取结果只是<b>草稿</b>：数值、尺寸、公差最终由技术确认。核准时必须填「带入去向」（例如已建的开发单号），
            否则草稿只是被标记了一下。
          </div>
        </div>

        <div class="split-r">
          <div v-if="!result" class="empty-box">左侧贴文本，点「抽取」</div>
          <div v-else>
            <div class="res-head">
              <b>抽取结果</b>
              <span class="pill" :class="result.confidence >= 0.8 ? 'p-green' : result.confidence >= 0.5 ? 'p-orange' : 'p-red'">
                把握度 {{ Math.round(result.confidence * 100) }}%
              </span>
              <span class="pill p-gray">{{ result.source === 'ai' ? '模型辅助' : '规则抽取' }}</span>
              <span class="res-no mono">{{ result.draft_no }}</span>
            </div>
            <div v-if="result.missing.length" class="miss-bar">
              缺必填项，必须去问客户：<b>{{ result.missing.map((m) => m.label).join('、') }}</b>
            </div>
            <table class="ex-tbl">
              <thead><tr><th style="width: 96px">项目</th><th>识别结果</th><th style="width: 84px" class="num">把握度</th></tr></thead>
              <tbody>
                <tr v-for="f in result.fields" :key="f.key">
                  <td class="tiny">{{ f.label }}</td>
                  <td class="tiny">
                    <template v-if="Array.isArray(f.value) && f.value.length && typeof f.value[0] === 'object'">
                      <span v-for="(s, i) in f.value" :key="i" class="chip">{{ s.size }}/{{ s.qty }}</span>
                    </template>
                    <template v-else-if="Array.isArray(f.value)">
                      <span v-for="(s, i) in f.value" :key="i" class="chip">{{ s }}</span>
                    </template>
                    <template v-else>{{ f.value }}<span v-if="f.currency" class="muted"> {{ f.currency }}</span></template>
                    <div v-if="f.assume" class="assume">推断：{{ f.assume }}</div>
                    <div v-if="f.evidence" class="ev">{{ f.evidence }}</div>
                  </td>
                  <td class="num tiny" :class="f.confidence >= 0.85 ? 'amt-green' : f.confidence >= 0.6 ? 'amt-orange' : 'muted'">
                    {{ Math.round(f.confidence * 100) }}%
                  </td>
                </tr>
                <tr v-if="!result.fields.length"><td colspan="3" class="empty">没抽到结构化信息，检查文本是否太短或不是需求描述</td></tr>
              </tbody>
            </table>
            <div class="craft-box">
              <div class="cb-title">工序建议（仅供参考，以下单工序为准）</div>
              <div class="steps"><span v-for="(s, i) in result.craft.steps" :key="i" class="step">{{ s }}</span></div>
              <div v-for="(n, i) in result.craft.notes" :key="'n' + i" class="cb-note">· {{ n }}</div>
            </div>
            <div v-if="result.ai_notes && result.ai_notes.length" class="craft-box">
              <div class="cb-title">模型提示需要确认的点</div>
              <div v-for="(n, i) in result.ai_notes" :key="'a' + i" class="cb-note">· {{ n }}</div>
            </div>
            <div class="form-row" style="margin-top: 8px">
              <button class="btn btn-ghost" @click="openDraftReview(result)">核准 / 驳回</button>
            </div>
          </div>
        </div>
      </div>

      <h4 style="margin-top: 18px">草稿箱<small>AI 产出都在这里，核准后才算数</small></h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 150px">草稿号</th><th style="width: 100px">场景</th><th style="width: 130px">来源</th>
            <th>内容摘要</th><th style="width: 90px">状态</th><th style="width: 110px">操作人</th><th style="width: 140px">核准去向</th><th style="width: 150px">操作</th></tr></thead>
          <tbody>
            <tr v-for="d in drafts" :key="d.id">
              <td class="tiny mono">{{ d.draft_no }}</td>
              <td class="tiny">{{ d.scene_label }}</td>
              <td class="tiny">{{ d.source_label }}</td>
              <td class="tiny wrap">{{ draftSummary(d) }}</td>
              <td><span class="pill" :class="d.status === 'approved' ? 'p-green' : d.status === 'rejected' ? 'p-gray' : 'p-orange'">{{ d.status_label }}</span></td>
              <td class="tiny">{{ d.created_by }}</td>
              <td class="tiny">{{ d.applied_to || '—' }}</td>
              <td class="ops">
                <button v-if="d.status === 'draft'" class="btn btn-ghost btn-sm" @click="openDraftReview(null, d)">核准</button>
                <button v-if="d.status === 'draft'" class="btn btn-ghost btn-sm" @click="openReject(d)">驳回</button>
                <span v-if="d.status !== 'draft'" class="tiny muted">{{ d.review_note || '—' }}</span>
              </td>
            </tr>
            <tr v-if="!drafts.length"><td colspan="8" class="empty">还没有草稿</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 3. 异常解释 ========== -->
    <div v-if="tab === 'explain'" class="block">
      <div class="split">
        <div class="split-l">
          <h4>当前异常<small>来自风险快照与勾稽问题</small></h4>
          <div class="anom-list">
            <div v-for="(a, i) in anomalies" :key="i" class="anom" :class="'lv-' + a.level" @click="doExplain(a)">
              <div class="anom-top">
                <span class="pill" :class="a.level === 'high' ? 'p-red' : 'p-orange'">{{ a.level === 'high' ? '高' : '中' }}</span>
                <b>{{ a.title }}</b>
              </div>
              <div class="anom-desc">{{ a.desc }}</div>
            </div>
            <div v-if="!anomalies.length" class="empty-box">暂无异常。可先到「风险预测」跑一次扫描。</div>
          </div>
        </div>
        <div class="split-r">
          <div v-if="!explainRes" class="empty-box">点左侧任意一条，看它「为什么变成这样」</div>
          <div v-else>
            <div class="res-head"><b>{{ explainRes.title }}</b>
              <span class="pill p-gray">{{ explainRes.source === 'ai' ? '模型润色' : '规则解释' }}</span>
            </div>
            <div v-if="explainRes.summary" class="sum-box">{{ explainRes.summary }}</div>
            <div v-for="(f, i) in explainRes.findings" :key="i" class="finding" :class="'fg-' + f.grade">
              <div class="fg-head">
                <span class="pill" :class="f.grade === 'read' ? 'p-gray' : 'p-orange'">{{ f.grade === 'read' ? '只读结论' : '需人工动作' }}</span>
                <b>{{ f.item }}</b>
              </div>
              <div class="fg-detail">{{ f.detail }}</div>
              <div v-if="f.evidence" class="ev">凭证：{{ f.evidence }}</div>
              <div v-if="f.action" class="fg-act">建议：{{ f.action }}</div>
            </div>
            <div class="hint-warn">{{ explainRes.note }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 4. 风险预测 ========== -->
    <div v-if="tab === 'risk'" class="block">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="riskRunning" @click="runRisk">{{ riskRunning ? '扫描中…' : '重新扫描全岗位' }}</button>
        <select v-model="riskLevel" @change="loadRisk">
          <option value="">全部级别</option><option value="high">高</option><option value="mid">中</option><option value="low">低</option>
        </select>
        <select v-model="riskRole" @change="loadRisk">
          <option value="">全部岗位</option>
          <option v-for="r in riskRoles" :key="r.role" :value="r.role">{{ r.label }}</option>
        </select>
        <span class="muted tiny">批次 {{ risk.run_id || '—' }} · 共 {{ risk.total || 0 }} 条</span>
      </div>
      <div class="hint-bar">
        风险按「<b>有明确时限的业务对象</b>」扫：待办审批、订单交期、工序计划、原料到货、质检、应收、邮件待办、勾稽严重问题。
        每条都给<b>分数、原因、责任人、建议动作</b>；<b>挂在没人认领的角色上会单独标出来</b> —— 这种最危险，因为没人会看到。
        系统只预警，<b>不会自动催人、自动改单或自动批准</b>。
      </div>
      <div class="table-wrap">
        <table class="tb-tbl risk-tbl">
          <thead><tr><th style="width: 58px" class="num">分数</th><th style="width: 86px">类型</th><th style="width: 190px">对象</th>
            <th>原因</th><th style="width: 130px">责任人</th><th style="width: 96px">岗位</th><th style="width: 150px">建议动作</th><th style="width: 96px">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in risk.rows" :key="r.id" :class="'row-' + r.level">
              <td class="num"><b :class="r.level === 'high' ? 'amt-red' : r.level === 'mid' ? 'amt-orange' : 'muted'">{{ r.score }}</b></td>
              <td class="tiny">{{ r.type_label }}</td>
              <td class="tiny mono">{{ r.entity_no }}</td>
              <td class="tiny wrap">
                <div v-for="(x, i) in r.reasons" :key="i">· {{ x }}</div>
              </td>
              <td class="tiny">
                {{ r.owner }}
                <span v-if="String(r.owner).includes('无在职账号')" class="pill p-red" style="margin-left: 4px">无人</span>
              </td>
              <td class="tiny">{{ r.role_label }}</td>
              <td class="tiny wrap">{{ r.next_action }}</td>
              <td class="ops">
                <button v-if="r.status === 'open'" class="btn btn-ghost btn-sm" @click="ackRisk(r, 'ack')">认领</button>
                <button v-if="r.status === 'open'" class="btn btn-ghost btn-sm" @click="ackRisk(r, 'done')">已处理</button>
                <span v-else class="tiny muted">{{ r.status === 'ack' ? '已认领' : '已处理' }}</span>
              </td>
            </tr>
            <tr v-if="!risk.rows || !risk.rows.length"><td colspan="8" class="empty">没有符合条件的风险项</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 5. 周报 ========== -->
    <div v-if="tab === 'weekly'" class="block">
      <div class="toolbar">
        <input v-model="weekInput" type="week" />
        <select v-model="weekScope">
          <option value="user">按人</option>
          <option v-if="isAdmin" value="dept">按部门</option>
          <option v-if="isAdmin" value="company">全公司</option>
        </select>
        <input v-if="weekScope === 'user'" v-model="weekSubject" placeholder="姓名或账号" style="width: 140px" />
        <button class="btn btn-primary" :disabled="weekLoading" @click="genWeekly">{{ weekLoading ? '生成中…' : '生成周报' }}</button>
      </div>
      <div class="hint-bar">
        周报按<b>真实业务事件</b>算：报工、完成的工序、处理过的审批、推进的订单、当前待办、超时项、被谁阻塞、<b>已确认</b>的扣分。
        AI 建议分<b>不写进正文</b>，单列在「待复核建议」—— 没确认的扣分不能当成事实。建议只给做法，不给评价。
      </div>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 96px">周次</th><th style="width: 110px">对象</th><th style="width: 76px">范围</th>
            <th class="num" style="width: 66px">完成</th><th class="num" style="width: 66px">待办</th>
            <th class="num" style="width: 66px">逾期</th><th class="num" style="width: 66px">阻塞</th>
            <th class="num" style="width: 74px">扣分</th><th style="width: 88px">状态</th><th style="width: 100px">操作</th></tr></thead>
          <tbody>
            <tr v-for="w in weeklies" :key="w.id">
              <td class="tiny mono">{{ w.week_no }}</td>
              <td class="tiny">{{ w.subject_name }}</td>
              <td class="tiny">{{ { user: '按人', dept: '部门', company: '公司' }[w.scope] }}</td>
              <td class="num tiny">{{ w.cnt_done }}</td>
              <td class="num tiny">{{ w.cnt_open }}</td>
              <td class="num tiny" :class="w.cnt_overdue ? 'amt-red' : ''">{{ w.cnt_overdue }}</td>
              <td class="num tiny" :class="w.cnt_blocked ? 'amt-orange' : ''">{{ w.cnt_blocked }}</td>
              <td class="num tiny" :class="w.cnt_penalty ? 'amt-red' : ''">{{ w.cnt_penalty }}</td>
              <td><span class="pill" :class="w.status === 'published' ? 'p-green' : 'p-gray'">{{ w.status === 'published' ? '已发布' : '草稿' }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="openWeekly(w)">查看</button></td>
            </tr>
            <tr v-if="!weeklies.length"><td colspan="10" class="empty">还没有周报，先点「生成周报」</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 6. 客服辅助 ========== -->
    <div v-if="tab === 'service'" class="block">
      <div class="split">
        <div class="split-l">
          <h4>客户问题 → 建议答复<small>优先引用已批准的标准答复，其次按订单真实进度生成</small></h4>
          <textarea v-model="replyQ" rows="4" placeholder="例：我这单什么时候能发货？订单号 SO202610260001"></textarea>
          <input v-model="replyCustomer" placeholder="客户（可选）" />
          <div class="form-row">
            <button class="btn btn-primary" :disabled="replyLoading || replyQ.trim().length < 4" @click="doReply">
              {{ replyLoading ? '生成中…' : '生成建议' }}
            </button>
            <button class="btn btn-ghost" @click="openHandover">转人工</button>
          </div>
          <div v-if="replyRes" class="reply-box">
            <div class="rb-head">
              建议答复
              <span class="pill" :class="replyRes.faq_hit ? 'p-green' : 'p-orange'">{{ replyRes.faq_hit ? '命中标准答复' : replyRes.source === 'ai' ? '模型起草' : '按订单生成' }}</span>
              <span class="mono tiny muted">{{ replyRes.draft_no }}</span>
            </div>
            <div class="rb-body">{{ replyRes.suggestion }}</div>
            <div v-if="replyRes.warning" class="hint-warn">{{ replyRes.warning }}</div>
            <div class="form-row" style="margin-top: 8px">
              <button class="btn btn-ghost btn-sm" @click="copyText(replyRes.suggestion)">复制</button>
            </div>
          </div>
        </div>
        <div class="split-r">
          <h4>标准答复库<small>必须批准后才能被引用；自己写不能自己批</small></h4>
          <div class="faq-list">
            <div v-for="f in faqs" :key="f.id" class="faq" :class="'fq-' + f.status">
              <div class="fq-q">{{ f.question }}<span class="pill" :class="f.status === 'approved' ? 'p-green' : f.status === 'retired' ? 'p-gray' : 'p-orange'">{{ f.status_label }}</span></div>
              <div class="fq-a">{{ f.answer }}</div>
              <div class="fq-ops">
                <span class="tiny muted">命中 {{ f.hit_count }} 次<span v-if="f.approved_by"> · 批准人 {{ f.approved_by }}</span></span>
                <button v-if="f.status !== 'approved'" class="btn btn-ghost btn-sm" @click="setFaq(f, 'approved')">批准</button>
                <button v-if="f.status === 'approved'" class="btn btn-ghost btn-sm" @click="setFaq(f, 'retired')">停用</button>
              </div>
            </div>
            <div v-if="!faqs.length" class="empty-box">还没有标准答复</div>
          </div>
          <div class="faq-new">
            <input v-model="faqQ" placeholder="新问题" />
            <textarea v-model="faqA" rows="3" placeholder="标准答复（至少 6 个字）"></textarea>
            <button class="btn btn-ghost btn-sm" :disabled="!faqQ || !faqA" @click="createFaq">＋ 新增待批准</button>
          </div>
        </div>
      </div>

      <h4 style="margin-top: 18px">人工接管<small>AI 答不了就转人，接管要留名，关单要写结论</small></h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 140px">会话号</th><th style="width: 120px">客户</th><th>问题</th>
            <th style="width: 180px">触发原因</th><th style="width: 96px">状态</th><th style="width: 100px">接管人</th><th style="width: 150px">操作</th></tr></thead>
          <tbody>
            <tr v-for="h in handovers" :key="h.id">
              <td class="tiny mono">{{ h.session_no }}</td>
              <td class="tiny">{{ h.customer || '—' }}</td>
              <td class="tiny wrap">{{ h.question }}</td>
              <td class="tiny wrap">{{ h.trigger_reason }}</td>
              <td><span class="pill" :class="h.status === 'closed' ? 'p-gray' : h.status === 'human' ? 'p-green' : 'p-orange'">{{ h.status_label }}</span></td>
              <td class="tiny">{{ h.taken_by || '—' }}</td>
              <td class="ops">
                <button v-if="h.status === 'ai'" class="btn btn-ghost btn-sm" @click="takeHandover(h)">接管</button>
                <button v-if="h.status !== 'closed'" class="btn btn-ghost btn-sm" @click="openCloseHandover(h)">关单</button>
                <span v-if="h.status === 'closed'" class="tiny muted">{{ h.summary }}</span>
              </td>
            </tr>
            <tr v-if="!handovers.length"><td colspan="7" class="empty">没有接管会话</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 7. 评测审计 ========== -->
    <div v-if="tab === 'eval'" class="block">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="evalRunning" @click="runEval">{{ evalRunning ? '跑批中…' : '跑一次评测' }}</button>
        <span class="muted tiny">共 {{ evalCases.length }} 条基准，其中「必须拒答」{{ refuseCount }} 条</span>
      </div>
      <div class="hint-bar">
        门禁口径：<b>越权泄漏必须为 0</b>。refuse 类用例先过权限守卫（代码层），再检查答案里有没有敏感内容；
        answer 类用例检查是否命中事实关键词，被过拦也会记下来（说明规则太粗）。
        模型换版本前先跑一遍这个，不要靠「演示一次看着对」。
      </div>

      <div v-if="lastRun" class="eval-hero" :class="lastRun.leak_cnt ? 'eh-bad' : 'eh-good'">
        <div>
          <div class="eh-title">{{ lastRun.leak_cnt ? '拦住：存在越权泄漏，不允许上线' : '通过：无越权泄漏，可上线' }}</div>
          <div class="eh-sub">{{ lastRun.run_no }} · 通过 {{ lastRun.passed }}/{{ lastRun.total }} · 泄漏 {{ lastRun.leak_cnt }} · 过拦 {{ lastRun.over_block }} · 用时 {{ lastRun.ms }}ms</div>
        </div>
      </div>

      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 84px">批次</th><th style="width: 130px">时间</th><th style="width: 76px">来源</th>
            <th class="num" style="width: 70px">通过</th><th class="num" style="width: 70px">失败</th>
            <th class="num" style="width: 80px">越权泄漏</th><th style="width: 90px">门禁</th><th style="width: 90px">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in evalRuns" :key="r.id">
              <td class="tiny mono">{{ r.run_no }}</td>
              <td class="tiny mono">{{ $fmt(r.created_at) }}</td>
              <td class="tiny">{{ r.source_label }}</td>
              <td class="num tiny">{{ r.passed }}</td>
              <td class="num tiny">{{ r.failed }}</td>
              <td class="num tiny" :class="r.leak_cnt ? 'amt-red' : 'amt-green'">{{ r.leak_cnt }}</td>
              <td><span class="pill" :class="r.leak_cnt ? 'p-red' : 'p-green'">{{ r.gate_label }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="openEvalRun(r)">明细</button></td>
            </tr>
            <tr v-if="!evalRuns.length"><td colspan="8" class="empty">还没跑过评测</td></tr>
          </tbody>
        </table>
      </div>

      <h4 style="margin-top: 18px">基准用例<small>答不出来的要补规则，能答出敏感内容的是安全事故</small></h4>
      <div class="table-wrap">
        <table class="tb-tbl case-tbl">
          <thead><tr><th style="width: 86px">编号</th><th style="width: 108px">期望</th><th style="width: 210px">用例</th>
            <th style="width: 88px">提问岗位</th><th>问题</th><th style="width: 74px">风险</th></tr></thead>
          <tbody>
            <tr v-for="c in evalCases" :key="c.case_code">
              <td class="tiny mono">{{ c.case_code }}</td>
              <td><span class="pill" :class="c.expect_kind === 'refuse' ? 'p-red' : 'p-green'">{{ c.expect_label }}</span></td>
              <td class="tiny">{{ c.title }}</td>
              <td class="tiny">{{ roleLabel(c.asker_role) }}</td>
              <td class="tiny wrap">{{ c.input_text }}</td>
              <td class="tiny">{{ c.risk_level === 'high' ? '高' : '一般' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 弹窗：草稿核准 ========== -->
    <div v-if="modal === 'approve'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>核准草稿 <b class="mono">{{ reviewTarget && reviewTarget.draft_no }}</b></h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>带入去向（必填）</label>
          <input v-model="approveForm.applied" placeholder="例：已建开发单 KP202610270001 / 已发给客户 张先生" />
          <label>备注</label>
          <input v-model="approveForm.note" placeholder="可选" />
          <div class="hint-bar" style="margin-top: 10px">
            核准<b>不会自动写业务表</b>：AI 抽取的结构化数据不等于业务真实，仍需按正常流程建单。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doApprove">确认核准</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：驳回 ========== -->
    <div v-if="modal === 'reject'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>驳回草稿 <b class="mono">{{ reviewTarget && reviewTarget.draft_no }}</b></h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>驳回原因（至少 4 个字，用于改进抽取规则）</label>
          <input v-model="rejectReason" placeholder="例：颜色识别错了，实际是藏青不是黑色" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doReject">确认驳回</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：转人工 ========== -->
    <div v-if="modal === 'handover'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>转人工</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>客户问题</label>
          <textarea v-model="hoForm.question" rows="3"></textarea>
          <label>触发原因（至少 4 个字）</label>
          <input v-model="hoForm.reason" placeholder="例：客户要求特殊工艺报价，AI 无法确认" />
          <label>客户</label>
          <input v-model="hoForm.customer" placeholder="可选" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doHandover">确认转人工</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：关单 ========== -->
    <div v-if="modal === 'closeHo'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>关单结论</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>处理结论（至少 4 个字）</label>
          <input v-model="closeHoSummary" placeholder="例：已电话答复，客户接受 12/20 交期" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doCloseHandover">确认关单</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：周报详情 ========== -->
    <div v-if="modal === 'weekly'" class="modal-mask" @click.self="closeModal">
      <div class="modal xwide">
        <div class="modal-head"><h3>周报 · {{ wk && wk.subject_name }} <b class="mono">{{ wk && wk.week_no }}</b></h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body" v-if="wk && wk.content">
          <div class="wk-meta">{{ wk.content.role_label }}<span v-if="wk.content.position"> · {{ wk.content.position }}</span> · {{ wk.period_from }} ~ {{ wk.period_to }}</div>

          <div class="wk-sec">
            <div class="wk-title">已完成</div>
            <div v-for="(d, i) in wk.content.done" :key="'d' + i" class="wk-item">
              <b>{{ d.label }}</b> — {{ d.detail }}
              <span v-if="d.refs && d.refs.length" class="tiny muted">（{{ d.refs.join('、') }}）</span>
            </div>
            <div v-if="!wk.content.done.length" class="muted tiny">本周没有登记完成的动作</div>
          </div>

          <div class="wk-sec" v-if="wk.content.open.length">
            <div class="wk-title">未完成（当前待办）</div>
            <div v-for="(d, i) in wk.content.open" :key="'o' + i" class="wk-item">
              · {{ d.label }}<span v-if="d.due_at" class="tiny muted"> · 要求 {{ d.due_at }} 前</span>
            </div>
          </div>

          <div class="wk-sec" v-if="wk.content.overdue.length">
            <div class="wk-title bad">即将逾期 / 已逾期</div>
            <div v-for="(d, i) in wk.content.overdue" :key="'v' + i" class="wk-item">
              · {{ d.entity }}：{{ (d.reasons || []).join('；') }}
            </div>
          </div>

          <div class="wk-sec" v-if="wk.content.blocked.length">
            <div class="wk-title warn">被谁阻塞</div>
            <div v-for="(d, i) in wk.content.blocked" :key="'b' + i" class="wk-item">· {{ d.label }}</div>
          </div>

          <div class="wk-sec" v-if="wk.content.penalty.length">
            <div class="wk-title bad">已确认扣分</div>
            <div v-for="(p, i) in wk.content.penalty" :key="'p' + i" class="wk-item">
              · {{ p.rule }} 扣 {{ p.score }} 分<span v-if="p.desc"> — {{ p.desc }}</span>
              <span v-if="p.ref" class="tiny muted">（{{ p.ref }}）</span>
              <span v-if="p.review && p.review !== 'confirmed'" class="pill p-orange" style="margin-left: 4px">复核中</span>
            </div>
          </div>

          <div class="wk-sec" v-if="wk.content.pending_review.length">
            <div class="wk-title warn">待复核建议（未确认，不算扣分）</div>
            <div v-for="(p, i) in wk.content.pending_review" :key="'r' + i" class="wk-item">
              · {{ p.rule }} 建议扣 {{ p.suggested }} 分<span v-if="p.desc"> — {{ p.desc }}</span>
            </div>
          </div>

          <div class="wk-sec">
            <div class="wk-title">下周建议</div>
            <div v-for="(s, i) in wk.content.suggestions" :key="'s' + i" class="wk-item">· {{ s }}</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">关闭</button>
          <button v-if="wk && wk.status !== 'published'" class="btn btn-primary" @click="publishWeekly">发布</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：评测明细 ========== -->
    <div v-if="modal === 'policyDoc' && pDoc" class="modal-mask" @click.self="closeModal">
      <div class="modal wide">
        <div class="modal-head">
          <h3>《{{ pDoc.title }}》<span class="mono tiny">{{ pDoc.doc_no }}</span></h3>
          <button class="x" @click="closeModal">×</button>
        </div>
        <div class="modal-body">
          <div class="pd-meta">
            <span class="pill" :class="pDoc.status === 'effective' ? 'p-green' : pDoc.status === 'retired' ? 'p-red' : 'p-orange'">{{ pDoc.status_label }}</span>
            <span class="pill p-blue">现行 V{{ pDoc.version }}</span>
            <span class="pill p-gray">{{ pDoc.category_label }}</span>
            <span class="tiny muted">生效日 <b>{{ pDoc.effective_date || '未填' }}</b> · 责任人 {{ pDoc.owner || '未指定' }} · 适用范围 {{ pDoc.position || '全岗位' }} · 已签收 {{ pDoc.acks }} 人</span>
          </div>
          <div class="pd-sec">
            <b>做法</b><p>{{ pDoc.doing || '—' }}</p>
          </div>
          <div class="pd-sec"><b>输入</b><p>{{ pDoc.inputs || '—' }}</p></div>
          <div class="pd-sec"><b>完成标准</b><p>{{ pDoc.done_criteria || '—' }}</p></div>
          <div class="pd-sec"><b>升级路径</b><p>{{ pDoc.escalate_path || '—' }}</p></div>

          <h4 style="margin-top: 14px">版本历史<small>引用旧版的回答在「引用留痕」里会被标红</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="tb-tbl">
              <thead><tr><th style="width: 70px">版本</th><th style="width: 90px">状态</th><th style="width: 120px">创建时间</th><th>变更说明</th></tr></thead>
              <tbody>
                <tr v-for="v in pDoc.versions" :key="v.id" :class="v.version === pDoc.current_version ? 'row-cur' : ''">
                  <td class="tiny"><b>V{{ v.version }}</b><span v-if="v.version === pDoc.current_version" class="pill p-green" style="margin-left: 6px">现行</span></td>
                  <td><span class="pill" :class="v.status === 'effective' ? 'p-green' : v.status === 'retired' ? 'p-red' : 'p-gray'">{{ v.status === 'effective' ? '生效' : v.status === 'retired' ? '废止' : '草稿' }}</span></td>
                  <td class="tiny mono">{{ $fmt(v.created_at) }}</td>
                  <td class="tiny wrap">{{ v.change_note || '—' }}</td>
                </tr>
                <tr v-if="!pDoc.versions.length"><td colspan="4" class="empty">还没有版本（草稿）</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>

    <div v-if="modal === 'evalRun'" class="modal-mask" @click.self="closeModal">
      <div class="modal xwide">
        <div class="modal-head"><h3>评测明细 <b class="mono">{{ evalDetail && evalDetail.run_no }}</b></h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div v-if="evalDetail" class="eval-hero" :class="evalDetail.leak_cnt ? 'eh-bad' : 'eh-good'" style="margin-bottom: 10px">
            <div>
              <div class="eh-title">{{ evalDetail.gate_label }}</div>
              <div class="eh-sub">通过 {{ evalDetail.passed }}/{{ evalDetail.total }} · 用时 {{ evalDetail.ms }}ms</div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="tb-tbl">
              <thead><tr><th style="width: 74px">编号</th><th style="width: 84px">期望</th><th style="width: 180px">用例</th>
                <th style="width: 60px">结果</th><th>答案 / 说明</th></tr></thead>
              <tbody>
                <tr v-for="r in (evalDetail && evalDetail.rows) || []" :key="r.id" :class="r.leaked ? 'row-bad' : ''">
                  <td class="tiny mono">{{ r.case_code }}</td>
                  <td><span class="pill" :class="r.expect_kind === 'refuse' ? 'p-red' : 'p-green'">{{ r.expect_label }}</span></td>
                  <td class="tiny">{{ r.title }}</td>
                  <td>
                    <span v-if="r.leaked" class="pill p-red">泄漏</span>
                    <span v-else-if="r.passed" class="pill p-green">通过</span>
                    <span v-else class="pill p-orange">未过</span>
                  </td>
                  <td class="tiny wrap">{{ r.answer }}<div v-if="r.note" class="muted" style="margin-top: 3px">{{ r.note }}</div></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import { auth } from '../store/auth';

const tab = ref('gateway');
const ov = ref({});
const calls = ref([]);
const callFilter = ref('');
const mode = computed(() => ov.value.mode || 'rule');
const isAdmin = computed(() => (auth.user && auth.user.role) === 'admin');

// ---------- 制度问答（N17-02） ----------
const pq = ref('');
const pLoading = ref(false);
const pResult = ref(null);
const pRecent = ref([]);
const pHits = ref({ rows: [], outdated: 0, note: '' });
const pDoc = ref(null);
const pOnlyOutdated = ref(false);
const pHitsView = computed(() => (pOnlyOutdated.value
  ? (pHits.value.rows || []).filter((h) => h.outdated)
  : (pHits.value.rows || [])));
const sampleQ = [
  '请假 3 天需要谁审批？',
  '出差住宿标准是多少？',
  '付款 30 万要谁批？',
  '样品能借多久？'
];

const tabs = computed(() => [
  { k: 'gateway', label: '模型网关' },
  { k: 'policy', label: '制度问答' },
  { k: 'extract', label: '需求抽取' },
  { k: 'explain', label: '异常解释' },
  { k: 'risk', label: '风险预测', dot: (ov.value.risk && ov.value.risk.stat && ov.value.risk.stat.high) || 0 },
  { k: 'weekly', label: '周报与绩效解释' },
  { k: 'service', label: '客服辅助与接管' },
  { k: 'eval', label: '评测审计' }
]);

// ---------- 通用 ----------
const modal = ref('');
const fmt = (v) => '¥' + (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const roleLabel = (r) => ({ admin: '管理员', sales: '销售', tech: '技术', finance: '财务', production: '生产', warehouse: '仓库' }[r] || r);
const scopeLabel = (s) => ({ public: '公开', internal: '内部', restricted: '受限（可含薪资/绩效）' }[s] || s);
function closeModal() { modal.value = ''; }
function toast(msg) { window.alert(msg); }

const lastEval = ref(null);

async function loadOverview() {
  const d = await api.aiOverview();
  ov.value = d;
  if (d.last_eval) lastEval.value = d.last_eval;
}

async function loadPolicy() {
  pRecent.value = await api.aiPolicyRecent({ limit: 8 });
  pHits.value = await api.aiPolicyHits({ limit: 20 });
}

/** 问制度：答案里的版本与日期由服务端拼，这里只负责展示 */
async function askPolicy(q) {
  const question = String(q || pq.value || '').trim();
  if (!question) return;
  pq.value = question;
  pLoading.value = true;
  try {
    pResult.value = await api.aiPolicyAsk({ question });
    pHits.value = await api.aiPolicyHits({ limit: 20 });
  } catch (e) {
    toast(e.message);
  } finally {
    pLoading.value = false;
  }
}

async function openPolicyDoc(no) {
  try {
    pDoc.value = await api.aiPolicyDoc(no);
    modal.value = 'policyDoc';
  } catch (e) {
    toast(e.message);
  }
}

function go(k) {
  tab.value = k;
  if (k === 'gateway') loadCalls();
  if (k === 'policy') loadPolicy();
  if (k === 'extract') { loadDrafts(); }
  if (k === 'explain') loadAnomalies();
  if (k === 'risk') loadRisk();
  if (k === 'weekly') loadWeeklies();
  if (k === 'service') { loadFaq(); loadHandovers(); }
  if (k === 'eval') { loadEvalCases(); loadEvalRuns(); }
}

// ---------- 网关 ----------
async function loadCalls() {
  const rows = await api.aiCalls({ status: callFilter.value, limit: 40 });
  calls.value = rows;
}

async function testProvider(p) {
  const r = await api.aiTestProvider(p.id);
  if (r.ok) toast(`连通成功：${r.answer}（${r.latency_ms}ms，花费 ${r.cost} 元）`);
  else toast(`未连通：${r.message || r.reason}`);
}

async function toggleProvider(p) {
  const next = p.status === 'enabled' ? 'disabled' : 'enabled';
  if (next === 'disabled' && !window.confirm(`确定停用 ${p.code}？停用后该供应商不再参与路由。`)) return;
  try {
    await api.aiUpdateProvider(p.id, { status: next });
    toast(next === 'enabled' ? '已启用' : '已停用');
    await loadOverview();
  } catch (e) { toast(e.message || '操作失败'); }
}

// ---------- 需求抽取 ----------
const extractText = ref('');
const extractLabel = ref('');
const extracting = ref(false);
const extractErr = ref('');
const result = ref(null);
const drafts = ref([]);

async function doExtract() {
  extracting.value = true; extractErr.value = '';
  try {
    result.value = await api.aiExtract({ text: extractText.value, source_label: extractLabel.value || undefined });
    await loadDrafts();
    await loadOverview();
  } catch (e) { extractErr.value = e.message || '抽取失败'; }
  extracting.value = false;
}

async function loadDrafts() {
  drafts.value = await api.aiDrafts({ limit: 30 });
}

function draftSummary(d) {
  const p = d.payload || {};
  if (d.scene === 'requirement') {
    const f = (p.fields || []).map((x) => `${x.label}=${Array.isArray(x.value) ? x.value.map((v) => (v && v.size ? v.size + '/' + v.qty : v)).join('/') : x.value}`);
    return f.slice(0, 5).join('，') + (f.length > 5 ? ' …' : '');
  }
  if (d.scene === 'reply') return (p.suggestion || '').slice(0, 60);
  if (d.scene === 'anomaly') return (p.summary || '') + '：' + ((p.findings || [])[0] ? p.findings[0].detail : '');
  return '';
}

const reviewTarget = ref(null);
const approveForm = ref({ applied: '', note: '' });
const rejectReason = ref('');

function openDraftReview(fresh, d) {
  reviewTarget.value = d || { id: fresh.id, draft_no: fresh.draft_no, scene: fresh.scene };
  approveForm.value = { applied: '', note: '' };
  modal.value = 'approve';
}
function openReject(d) {
  reviewTarget.value = d; rejectReason.value = ''; modal.value = 'reject';
}

async function doApprove() {
  try {
    await api.aiApproveDraft(reviewTarget.value.id, { applied_to: approveForm.value.applied, note: approveForm.value.note });
    closeModal(); await loadDrafts(); await loadOverview();
    toast('已核准');
  } catch (e) { toast(e.message || '核准失败'); }
}

async function doReject() {
  try {
    await api.aiRejectDraft(reviewTarget.value.id, { reason: rejectReason.value });
    closeModal(); await loadDrafts(); await loadOverview();
    toast('已驳回');
  } catch (e) { toast(e.message || '驳回失败'); }
}

// ---------- 异常解释 ----------
const anomalies = ref([]);
const explainRes = ref(null);

async function loadAnomalies() {
  const d = await api.aiAnomalies({ limit: 30 });
  anomalies.value = d.rows;
}

async function doExplain(a) {
  explainRes.value = await api.aiExplain({ entity_type: a.entity_type, entity_id: a.entity_id, entity_no: a.entity_no });
}

// ---------- 风险 ----------
const risk = ref({});
const riskRunning = ref(false);
const riskLevel = ref('');
const riskRole = ref('');
const riskRoles = ref([]);

async function runRisk() {
  riskRunning.value = true;
  try {
    const r = await api.aiRiskRun();
    toast(`扫描完成：${r.run_id}，共 ${r.total} 条（高 ${r.high} / 中 ${r.mid} / 低 ${r.low}），其中无人认领 ${r.unowned} 条`);
    await loadRisk(); await loadOverview(); await loadAnomalies();
  } catch (e) { toast(e.message || '扫描失败'); }
  riskRunning.value = false;
}

async function loadRisk() {
  const d = await api.aiRisk({ level: riskLevel.value, role: riskRole.value });
  risk.value = d;
  riskRoles.value = d.roles || [];
}

async function ackRisk(r, status) {
  try {
    await api.aiAckRisk(r.id, { status });
    await loadRisk();
  } catch (e) { toast(e.message || '操作失败'); }
}

// ---------- 周报 ----------
const weeklies = ref([]);
const weekInput = ref('');
const weekScope = ref('user');
const weekSubject = ref('');
const weekLoading = ref(false);
const wk = ref(null);

async function genWeekly() {
  weekLoading.value = true;
  try {
    const r = await api.aiGenWeekly({
      week: weekInput.value || undefined,
      scope: weekScope.value,
      subject: weekScope.value === 'user' ? weekSubject.value : undefined
    });
    toast(`已生成 ${r.week_no}：${r.count} 份`);
    await loadWeeklies(); await loadOverview();
  } catch (e) { toast(e.message || '生成失败'); }
  weekLoading.value = false;
}

async function loadWeeklies() {
  const d = await api.aiWeekly({ limit: 60 });
  weeklies.value = d.rows;
}

async function openWeekly(w) {
  wk.value = await api.aiWeeklyDetail(w.id);
  modal.value = 'weekly';
}

async function publishWeekly() {
  try {
    await api.aiPublishWeekly(wk.value.id);
    wk.value.status = 'published';
    await loadWeeklies();
    toast('已发布');
  } catch (e) { toast(e.message || '发布失败'); }
}

// ---------- 客服 ----------
const replyQ = ref('');
const replyCustomer = ref('');
const replyLoading = ref(false);
const replyRes = ref(null);
const faqs = ref([]);
const faqQ = ref('');
const faqA = ref('');
const handovers = ref([]);
const hoForm = ref({ question: '', reason: '', customer: '' });
const closeHoSummary = ref('');
const closingHo = ref(null);

async function doReply() {
  replyLoading.value = true;
  try {
    replyRes.value = await api.aiReply({ question: replyQ.value, customer: replyCustomer.value || undefined });
    await loadOverview();
  } catch (e) { toast(e.message || '生成失败'); }
  replyLoading.value = false;
}

function copyText(t) {
  navigator.clipboard?.writeText(t).then(() => toast('已复制到剪贴板'), () => toast('复制失败，请手动选中'));
}

async function loadFaq() { faqs.value = await api.aiFaq({}); }

async function createFaq() {
  try {
    await api.aiCreateFaq({ question: faqQ.value, answer: faqA.value });
    faqQ.value = ''; faqA.value = '';
    await loadFaq(); await loadOverview();
    toast('已新增，等待批准');
  } catch (e) { toast(e.message || '新增失败'); }
}

async function setFaq(f, status) {
  try {
    await api.aiUpdateFaq(f.id, { status });
    await loadFaq(); await loadOverview();
    toast(status === 'approved' ? '已批准' : '已停用');
  } catch (e) { toast(e.message || '操作失败'); }
}

async function loadHandovers() { handovers.value = await api.aiHandovers({}); }

function openHandover() {
  hoForm.value = { question: replyQ.value, reason: '', customer: replyCustomer.value };
  modal.value = 'handover';
}

async function doHandover() {
  try {
    await api.aiCreateHandover(hoForm.value);
    closeModal(); await loadHandovers(); await loadOverview();
    toast('已转人工');
  } catch (e) { toast(e.message || '转人工失败'); }
}

async function takeHandover(h) {
  try {
    await api.aiTakeHandover(h.id);
    await loadHandovers();
  } catch (e) { toast(e.message || '接管失败'); }
}

function openCloseHandover(h) { closingHo.value = h; closeHoSummary.value = ''; modal.value = 'closeHo'; }

async function doCloseHandover() {
  try {
    await api.aiCloseHandover(closingHo.value.id, { summary: closeHoSummary.value });
    closeModal(); await loadHandovers(); await loadOverview();
    toast('已关单');
  } catch (e) { toast(e.message || '关单失败'); }
}

// ---------- 评测 ----------
const evalCases = ref([]);
const evalRuns = ref([]);
const evalDetail = ref(null);
const evalRunning = ref(false);
const refuseCount = computed(() => evalCases.value.filter((c) => c.expect_kind === 'refuse').length);

async function loadEvalCases() { evalCases.value = await api.aiEvalCases(); }

async function loadEvalRuns() {
  const rows = await api.aiEvalRuns({ limit: 20 });
  evalRuns.value = rows;
  if (rows.length) {
    lastEval.value = rows[0];
  }
}

async function runEval() {
  evalRunning.value = true;
  try {
    const r = await api.aiEvalRun({ mode: 'rule' });
    toast(`${r.run_no}：通过 ${r.passed}/${r.total}，越权泄漏 ${r.leak_cnt}，过拦 ${r.over_block}\n${r.gate_label}`);
    await loadEvalRuns();
  } catch (e) { toast(e.message || '评测失败'); }
  evalRunning.value = false;
}

async function openEvalRun(r) {
  evalDetail.value = await api.aiEvalRunDetail(r.id);
  modal.value = 'evalRun';
}

// ---------- 初始化 ----------
async function reloadAll() {
  await loadOverview();
  await go(tab.value);
}

onMounted(async () => {
  await loadOverview();
  await loadCalls();
});
</script>

<style scoped>
/* 页签单行横向滚动：换行会让父容器算不出高度，导致下一块内容盖上来 */
.tabbar { display: flex; align-items: flex-start; margin-bottom: 6px; }
.tabbar .tabs { margin-left: 0; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.tabbar .tabs button { flex: 0 0 auto; white-space: nowrap; }
.mode-pill { font-size: 12px; border-radius: 8px; padding: 4px 10px; font-weight: 600; }
.mp-ai { background: #eaf7ef; color: #16803c; }
.mp-rule { background: #fff6e8; color: #b46207; }

.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.stat.st-good { background: #f2fbf5; border-color: #cfe9d8; }
.stat.st-good strong { color: #16a34a; }
.stat.st-warn { background: #fffaf2; border-color: #f3e0c2; }
.stat.st-warn strong { color: #d97706; }
.stat.st-bad { background: #fff5f6; border-color: #f6d4d9; }
.stat.st-bad strong { color: #d92d45; }

.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.tiny { font-size: 11.5px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.wrap { white-space: normal; line-height: 1.55; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #a9b4c5; font-size: 12px; padding: 18px 0; }
.row-high { background: #fff7f8; }
.row-mid { background: #fffdf7; }
.row-bad { background: #fff7f8; }

.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.75; margin: 0 0 12px; }
.hint-warn { background: #fffaf2; border: 1px solid #f3e0c2; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #b46207; margin: 10px 0 0; line-height: 1.7; }
.err-bar { background: #fff5f6; border: 1px solid #f6d4d9; color: #c0243c; border-radius: 9px; padding: 8px 11px; font-size: 12.5px; margin-top: 10px; }
.block { margin-top: 16px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }

.pill { display: inline-block; white-space: nowrap; font-size: 11px; border-radius: 5px; padding: 1px 6px; }
.p-green { background: #eaf7ef; color: #16803c; }
.p-orange { background: #fff4e5; color: #b46207; }
.p-red { background: #fdecef; color: #c0243c; }
.p-gray { background: #eef1f6; color: #6b7789; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }

/* 供应商卡片 */
.prov-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.prov-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 13px; }
.prov-card.pc-enabled { border-color: #cfe9d8; background: #fafefb; }
.prov-card.pc-disabled { background: #fafbfd; }
.pc-head { display: flex; justify-content: space-between; align-items: center; }
.pc-head b { font-size: 13px; color: #16233b; font-family: ui-monospace, Menlo, Consolas, monospace; }
.pc-name { font-size: 12.5px; color: #4a566e; margin: 4px 0 8px; }
.pc-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: #8a94a6; padding: 2px 0; gap: 10px; }
.pc-row b { color: #3d4a63; font-weight: 600; text-align: right; overflow-wrap: anywhere; min-width: 0; }
.bar { height: 4px; background: #eef1f6; border-radius: 3px; margin: 7px 0 6px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #3b82f6; border-radius: 3px; }
.bar i.bar-bad { background: #d92d45; }
.pc-note { font-size: 11px; color: #a9b4c5; line-height: 1.6; }
.pc-block { font-size: 11.5px; color: #c0243c; background: #fff5f6; border-radius: 6px; padding: 4px 7px; margin-top: 6px; }
.pc-ops { margin-top: 9px; display: flex; gap: 6px; }

/* 分栏 */
.split { display: grid; grid-template-columns: 1fr 1.3fr; gap: 14px; }
.split-l, .split-r { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 13px; }
.split h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.split h4 small { display: block; margin-top: 3px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }
textarea { width: 100%; border: 1px solid #dfe5ee; border-radius: 8px; padding: 8px 10px; font-size: 12.5px; line-height: 1.7; resize: vertical; font-family: inherit; }
input:not([type]), input[type='week'] { border: 1px solid #dfe5ee; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; }
.form-row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.form-row input { flex: 1; }
.empty-box { color: #a9b4c5; font-size: 12.5px; text-align: center; padding: 40px 0; }

/* 抽取结果 */
.res-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.res-head b { font-size: 13px; color: #16233b; }
.res-no { font-size: 11px; color: #a9b4c5; margin-left: auto; }
.miss-bar { background: #fdecef; border: 1px solid #f6d4d9; color: #c0243c; border-radius: 8px; padding: 7px 10px; font-size: 12px; margin-bottom: 8px; }
.ex-tbl { width: 100%; }
.ex-tbl td { vertical-align: top; padding: 5px 6px; }
.chip { display: inline-block; white-space: nowrap; background: #eef2f8; color: #3d4a63; border-radius: 6px; padding: 1px 6px; margin: 1px 4px 1px 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
.ev { color: #a9b4c5; font-size: 10.5px; margin-top: 2px; }
.assume { color: #b46207; font-size: 10.5px; }
.craft-box { background: #f8fafd; border: 1px solid #e8eef7; border-radius: 9px; padding: 9px 11px; margin-top: 10px; }
.cb-title { font-size: 12px; color: #3d4a63; font-weight: 600; margin-bottom: 6px; }
.steps { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.step { white-space: nowrap; font-size: 11px; background: #fff; border: 1px solid #dfe5ee; border-radius: 6px; padding: 1px 7px; color: #4a566e; }
.step + .step::before { content: '→'; color: #c3ccda; margin-right: 5px; }
.cb-note { font-size: 11.5px; color: #6b7789; line-height: 1.7; }

/* 异常 */
.anom-list { max-height: 520px; overflow: auto; }
.anom { border: 1px solid #eef1f6; border-radius: 9px; padding: 8px 10px; margin-bottom: 7px; cursor: pointer; }
.anom:hover { border-color: #c9d6ea; background: #fafcff; }
.anom.lv-high { border-left: 3px solid #d92d45; }
.anom.lv-mid { border-left: 3px solid #d97706; }
.anom-top { display: flex; align-items: center; gap: 6px; }
.anom-top b { font-size: 12px; color: #16233b; }
.anom-desc { font-size: 11.5px; color: #8a94a6; margin-top: 3px; line-height: 1.6; }
.sum-box { background: #f6f9ff; border-radius: 8px; padding: 9px 11px; font-size: 12.5px; color: #3d4a63; line-height: 1.75; margin-bottom: 10px; }
.finding { border: 1px solid #eef1f6; border-radius: 9px; padding: 8px 10px; margin-bottom: 7px; }
.finding.fg-draft { border-color: #f3e0c2; background: #fffdf7; }
.fg-head { display: flex; align-items: center; gap: 6px; }
.fg-head b { font-size: 12px; color: #16233b; }
.fg-detail { font-size: 12px; color: #4a566e; line-height: 1.7; margin-top: 4px; }
.fg-act { font-size: 11.5px; color: #b46207; margin-top: 4px; }

/* 客服 */
.reply-box { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; margin-top: 10px; background: #fafcff; }
.rb-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #16233b; font-weight: 600; margin-bottom: 6px; flex-wrap: wrap; }
.rb-body { font-size: 12.5px; color: #3d4a63; line-height: 1.85; white-space: pre-wrap; }
.faq-list { max-height: 340px; overflow: auto; }
.faq { border: 1px solid #eef1f6; border-radius: 9px; padding: 8px 10px; margin-bottom: 7px; }
.faq.fq-approved { border-color: #cfe9d8; background: #fafefb; }
.fq-q { font-size: 12px; color: #16233b; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.fq-a { font-size: 11.5px; color: #6b7789; line-height: 1.7; margin: 4px 0; }
.fq-ops { display: flex; justify-content: space-between; align-items: center; }
.faq-new { border-top: 1px dashed #e6ebf3; padding-top: 9px; margin-top: 9px; display: grid; gap: 6px; }

/* 周报 */
.wk-meta { font-size: 12px; color: #8a94a6; margin-bottom: 10px; }
.wk-sec { margin-bottom: 12px; }
.wk-title { font-size: 12.5px; font-weight: 600; color: #16233b; margin-bottom: 5px; border-left: 3px solid #cbd7ea; padding-left: 7px; }
.wk-title.bad { border-color: #d92d45; color: #c0243c; }
.wk-title.warn { border-color: #d97706; color: #b46207; }
.wk-item { font-size: 12px; color: #4a566e; line-height: 1.8; padding-left: 8px; }

/* 评测 */
.eval-hero { border-radius: 10px; padding: 11px 14px; border: 1px solid #e6ebf3; }
.eh-good { background: #f2fbf5; border-color: #cfe9d8; }
.eh-bad { background: #fff5f6; border-color: #f6d4d9; }
.eh-title { font-size: 13.5px; font-weight: 600; color: #16233b; }
.eh-sub { font-size: 11.5px; color: #8a94a6; margin-top: 3px; }

/* 表格 */
.tb-tbl { min-width: 1020px; width: 100%; }
.tb-tbl th { text-align: left; }
.tb-tbl th.num { text-align: right; }
.risk-tbl { min-width: 1180px; }
.case-tbl { min-width: 1160px; }
.case-tbl td, .case-tbl th { padding-left: 8px; padding-right: 8px; }

.modal.xwide { width: 1000px; }
.modal-body label { display: block; font-size: 12px; color: #8a94a6; margin: 8px 0 4px; }
.modal-body input { width: 100%; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .prov-grid { grid-template-columns: 1fr; }
  .split { grid-template-columns: 1fr; }
  .modal.xwide { width: calc(100vw - 24px); }
}

/* ---------- 制度问答 ---------- */
.pq-bar { display: flex; gap: 10px; margin-bottom: 8px; }
.pq-bar .input { flex: 1; padding: 10px 12px; border: 1px solid #dfe5ef; border-radius: 9px; font-size: 13.5px; font-family: inherit; }
.pq-chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.chip {
  border: 1px solid #dbe4f3; background: #f7faff; color: #2563eb; border-radius: 16px;
  padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.chip:hover { background: #eef4ff; }
.chk { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: #4b5568; }
.pw-result { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px 16px; margin-bottom: 8px; }
.pw-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.pw-head .spacer { flex: 1; }
.pw-answer {
  margin: 0 0 12px; padding: 12px 14px; background: #f8fafd; border: 1px solid #eef2f7; border-radius: 9px;
  font-size: 13px; line-height: 1.75; color: #1f2937; white-space: pre-wrap; word-break: break-word;
  font-family: inherit;
}
.pw-cites { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.cite { border: 1px solid #dbe7ff; background: #f7faff; border-radius: 9px; padding: 9px 12px; }
.cite-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: #16233b; }
.cite-top .spacer { flex: 1; }
.cite-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: #6b7688; margin-top: 5px; }
.cite-meta b { color: #16233b; }
.pw-basis { border-top: 1px dashed #e8edf6; padding-top: 10px; }
.basis-row { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; font-size: 12.5px; color: #33415a; border-bottom: 1px dashed #f0f3f8; }
.basis-text { flex: 1; line-height: 1.6; }
.pw-blocked { background: #fffafa; border: 1px solid #f3c2c9; border-radius: 9px; padding: 10px 12px; font-size: 12.5px; color: #33415a; }
.inv-row { margin-top: 6px; line-height: 1.7; }
.pd-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.pd-sec { border-bottom: 1px dashed #eef2f7; padding: 6px 0; font-size: 13px; }
.pd-sec b { color: #8a94a6; font-weight: 600; font-size: 12px; display: block; margin-bottom: 3px; }
.pd-sec p { margin: 0; color: #1f2937; line-height: 1.7; }
.row-cur { background: #f6fdf9; }
.row-bad { background: #fffafa; }
.amt-red { color: #d92d45; }
.amt-green { color: #16a34a; }
.red { color: #d92d45; }
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, Consolas, monospace; }
/* 表头别折行（「版本数」和「操作」挤在一起像一列） */
.tb-tbl th { white-space: nowrap; padding-right: 10px; }
.tb-tbl td.mono { white-space: nowrap; }

@media (max-width: 900px) {
  .pq-bar { flex-wrap: wrap; }
  .pq-bar .input { width: 100%; }
  .cite-meta { gap: 8px; }
}
</style>
