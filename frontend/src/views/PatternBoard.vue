<template>
  <SampleWorkbench v-if="route.query.workbench==='sample'"/>
  <template v-else>
  <div class="pattern-workspace reference-board">
    <div class="page-head">
      <div>
        <h2>打版流程</h2>
        <div class="sub">面辅料确认 → 制版 → 工艺明细 → 车板做样衣 → 业务确认样 → 工序审核·工价核价；走完自动归档样衣</div>
      </div>
      <div style="display: flex; gap: 10px">
        <button class="btn btn-ghost" @click="load">刷新</button>
      </div>
    </div>

    <div class="pattern-filters">
      <label>款号<input class="input" v-model="q" placeholder="搜索款号 / 订单号"/></label><label v-for="field in referenceFilters" :key="field[0]">{{field[1]}}<input class="input" v-model="boardFilters[field[0]]" :placeholder="'搜索'+field[1]"/></label><label>客户<input class="input" v-model="boardFilters.customer" placeholder="搜索客户" /></label>
      <label>纸样师<input class="input" v-model="boardFilters.patternOwner" placeholder="选择纸样师" list="pattern-owners" /><datalist id="pattern-owners"><option v-for="owner in boardOwners('pattern')" :key="owner" :value="owner" /></datalist></label>
      <label>车版师<input class="input" v-model="boardFilters.sampleOwner" placeholder="选择车版师" list="sample-owners" /><datalist id="sample-owners"><option v-for="owner in boardOwners('sample')" :key="owner" :value="owner" /></datalist></label>
      <label>标签<input class="input" v-model="boardFilters.label" placeholder="搜索标签" /></label>
      <label>预计出版时间<input class="input" type="date" v-model="boardFilters.due" /></label>
      <label>流程状态<select class="input" v-model="boardFilters.hold"><option value="">全部</option><option value="hold">修改审核中</option><option value="active">可正常推进</option></select></label>
      <button class="btn btn-ghost" @click="resetBoardFilters()">重置筛选</button>
    </div>

    <div class="toolbar" style="margin-bottom: 12px"><PatternManagement ref="managementRef" @configured="applyBoardConfig" @fill="f=>openStage(f,f.current_stage)"/>
      <input class="input" v-model="q" placeholder="搜索 款号 / 订单号 / 客户" style="width: 260px" @keyup.enter="load" />
      <button class="btn btn-ghost" @click="load">查询</button>
</div>

    <!-- 流程指示条 -->
    <div class="flow-bar">
      <div v-for="(s, i) in stages" :key="s.key" class="flow-step"
           :class="{ done: stepDone(s.key), cur: countByStage(s.key) > 0 }"
           :title="'点击定位到「' + s.label + '」列（' + countByStage(s.key) + ' 张）'"
           @click="jumpToStage(s.key)">
        <span class="dot">{{ stepDone(s.key) ? '✓' : i + 1 }}</span>
        <span class="lbl">{{ s.label }}</span>
        <span class="cnt">{{ countByStage(s.key) }}</span>
      </div>
      <div class="flow-step end" :class="{ done: false }">
        <span class="dot">✓</span>
        <span class="lbl">已完成 / 样衣归档</span>
        <span class="cnt">{{ doneCount }}</span>
      </div>
    </div>

    <nav class="pattern-stage-tabs" aria-label="打版阶段切换"><button :class="{active:boardTab==='all'}" @click="boardTab='all'">全部 {{flows.filter(matchesBoard).length}}</button><button v-for="s in stages" :key="s.key" :class="{active:boardTab===s.key}" @click="boardTab=s.key">{{s.label}} {{colCards(s.key).length}}</button><button :class="{active:boardTab==='done'}" @click="boardTab='done'">已归档 {{doneFlows.length}}</button></nav>
    <!-- 看板 -->
    <div class="pboard">
      <div v-for="s in visibleBoardStages" :key="s.key" class="pcol">
        <div class="pcol-head">
          <span>{{ s.label }}</span>
          <span class="pcount">{{ colCards(s.key).length }}</span>
        </div>
        <input class="input pcol-search" v-model="columnQueries[s.key]" placeholder="请输入款号" :aria-label="s.label + '款号搜索'" />
        <div class="pcol-body">
          <div v-for="f in colCards(s.key)" :key="f.id" class="pcard" @click="openStage(f, s.key)">
            <div class="pcard-top"><button class="task-edit-icon" title="任务信息" @click.stop="managementRef.editTask(f)">✎</button>
              <strong class="pstyle" :title="f.customer_style_no || f.product_name">{{ f.customer_style_no || f.product_name }}</strong>
              <span class="tag" :class="stageTag(f.stage_map[s.key])">{{ stageStatusLabel(f.stage_map[s.key]) }}</span>
            </div>
            <img v-if="f.image_url" class="pattern-card-image" :src="f.image_url" :alt="f.customer_style_no || f.product_name" @click.stop="openImage(f.image_url,f.customer_style_no||f.product_name)" />
            <div v-if="f.change_hold" class="change-hold-badge">业务信息变更审核中 · 流程暂停</div>
            <div v-if="taskBadge(f)" class="pline"><span class="task-urgency" :style="{background:taskBadge(f).background,color:taskBadge(f).foreground}">{{taskBadge(f).name}}</span></div><div v-if="boardConfig.tasks[f.id]?.secondary_status" class="pline">二级状态：{{boardConfig.tasks[f.id].secondary_status}}</div><div class="pline">款号：{{f.customer_style_no||'版房待填写'}}</div><div class="pline">打版颜色：{{f.stage_map[s.key]?.data?.basic_info?.colors||'—'}}</div><div class="pline">版号：{{ f.version }} · {{ f.product_name }}</div>
            <div class="pline">打版尺码：{{ f.stage_map[s.key]?.pattern_size || f.stage_map.pattern?.pattern_size || '—' }}</div>
            <div class="pline">标签：{{ f.stage_map[s.key]?.label_name || '—' }}</div>
            <div class="pline">负责人：{{ f.stage_map[s.key]?.owner || '—' }}</div>
            <div class="pline">客户：{{ f.customer_name || '-' }}</div>
            <div class="pline">创建：{{ $fmtDate(f.started_at) }}</div>
            <div class="pline muted" v-if="f.stage_map[s.key] && f.stage_map[s.key].remark">备注：{{ f.stage_map[s.key].remark }}</div>
            <div class="pmeta">
              <span>作业 {{ f.stage_map[s.key] && f.stage_map[s.key].work_hours || 0 }}h</span>
              <span v-if="f.stage_map[s.key] && f.stage_map[s.key].due_date">预计 {{ f.stage_map[s.key].due_date }}</span>
              <span v-if="f.stage_map[s.key] && f.stage_map[s.key].actual_hours">实际 {{ f.stage_map[s.key].actual_hours }}h</span>
            </div>
            <div class="pacts">
              <span class="pattern-time">移入时间：{{ fmtTime(f.stage_map[s.key]?.started_at) }}</span>
              <span class="pattern-time" v-if="f.stage_map[s.key]?.due_date">预计完成：{{ f.stage_map[s.key].due_date }}</span>
              <button class="link-btn" @click.stop="openStage(f, s.key)">填写</button><button class="link-btn" @click.stop="openStage(f,s.key)">详情</button><button class="link-btn" @click.stop="printPattern(f)">打印</button>
            </div>
          </div>
          <div v-if="!colCards(s.key).length" class="pempty"><span class="empty-box">◇</span><small>暂无任务</small></div>
        </div>
      </div>

      <div class="pcol">
        <div class="pcol-head"><span>已完成 · 已归档样衣</span><span class="pcount">{{ doneFlows.length }}</span></div>
        <input class="input pcol-search" v-model="columnQueries.done" placeholder="请输入款号" aria-label="已完成款号搜索" />
        <div class="pcol-body">
          <div v-for="f in doneFlows" :key="f.id" class="pcard done" @click="openStage(f, 'audit')">
            <div class="pcard-top">
              <strong class="pstyle">{{ f.customer_style_no || f.product_name }}</strong>
              <span class="tag green">已完成</span>
            </div>
            <div class="pline">{{ f.pre_order_no ? '预下单：' : '订单：' }}{{ f.pre_order_no || f.order_no || '-' }}</div>
            <div class="pline">客户：{{ f.customer_name || '-' }}</div>
            <div class="pline muted">完成：{{ $fmtDate(f.finished_at) }}</div>
            <div class="pacts">
              <button class="link-btn" @click.stop="openStage(f, 'audit')">查看打版记录</button>
              <button class="link-btn" @click.stop="goSample(f)">样衣档案 →</button>
            </div>
          </div>
          <div v-if="!doneFlows.length" class="pempty">还没有归档的样衣</div>
        </div>
      </div>
    </div>

    <!-- 面辅料档案选择器 -->
    <MaterialPicker :open="pickerOpen" :type="pickerType" @close="pickerOpen = false" @picked="onPicked" />

    <!-- 阶段填写 -->
    <div v-if="cur" class="modal-mask">
      <div class="modal xwide pb-modal task-reference-modal">
        <div class="modal-head">
          <h3>
            {{ stageLabel(cur.stage) }} · {{ cur.flow.customer_style_no || cur.flow.product_name }}
            <span class="tag" :class="stageTag(cur.data)">{{ stageStatusLabel(cur.data) }}</span>
          </h3>
          <button class="x" @click="closeStage">×</button>
        </div>
        <div class="modal-body">
          <div class="stage-strip">
            <span v-for="(s, i) in stages" :key="s.key" class="ss"
                  :class="{ on: s.key === cur.stage, done: cur.flow.stage_map[s.key].status === 'done', jump: s.key !== cur.stage }"
                  :title="s.key === cur.stage ? '' : '切换到「' + s.label + '」'"
                  @click="switchStage(s.key)">
              {{ i + 1 }}. {{ s.label }}
            </span>
          </div>

          <section v-if="cur.flow.change_requests && cur.flow.change_requests.length" class="change-panel">
            <div class="change-panel-head"><strong>业务信息修改审核</strong><span>批准修改后还需完成修改后复核，流程才会恢复</span></div>
            <article v-for="change in cur.flow.change_requests" :key="change.id" class="change-item">
              <div class="change-item-top"><b>{{ changeFieldLabel(change.field_key) }}</b><span class="tag" :class="changeStatusTag(change.status)">{{ changeStatusLabel(change.status) }}</span></div>
              <div class="change-reason">{{ change.reason }} · 申请人 {{ change.applicant || '—' }}</div>
              <p v-if="change.field_key==='development_revision' && change.status==='editing'" class="change-note">版房已批准并更新样版版本，等待业务在开发管理保存修改，之后再由版房复核。</p><div v-if="change.field_key!=='development_revision'" class="change-value"><small>申请修改为</small><p>{{change.field_key==='development_submission'?'审核业务提交的面辅料、工艺、客户要求':change.proposed_value}}</p></div>
              <div v-if="change.review_note" class="change-note">审核意见：{{ change.review_note }}</div>
              <div v-if="change.recheck_note" class="change-note">复核意见：{{ change.recheck_note }}</div>
              <div class="change-actions">
                <template v-if="change.status === 'pending' && can('pattern.review')"><button class="btn btn-sm btn-primary" :disabled="busy" @click="reviewChange(change,true)">{{change.field_key==='development_submission'?'审核通过，准予打版':'同意修改'}}</button><button  class="btn btn-sm btn-ghost" :disabled="busy" @click="reviewChange(change,false)">驳回</button></template>
                <template v-if="change.status === 'awaiting_recheck' && can('pattern.review')"><button class="btn btn-sm btn-primary" :disabled="busy" @click="recheckChange(change,true)">修改后审核通过，继续打版</button><button class="btn btn-sm btn-ghost" :disabled="busy" @click="recheckChange(change,false)">修改后复核不通过</button></template>
              </div>
            </article>
          </section>
          <div v-if="cur.flow.change_hold" class="change-pause-note">当前流程已暂停。所有阶段的保存、完成和归档操作都会等待审核结束。</div>

          <PatternTaskBasics :form="form" :readonly="!canEdit" :style-no="cur.flow.customer_style_no||cur.flow.product_name" :customer="cur.flow.customer_name" :cost="materials.length?matTotal:null"/>
          <details class="stage-more"><summary>阶段作业时间及专项资料</summary><div class="form-grid">
            <div class="fitem"><label>负责人 / 版师</label>
              <input class="input" v-model="form.owner" :disabled="!canEdit" placeholder="填写处理人" /></div>
            <div class="fitem"><label>打板尺码</label>
              <input class="input" v-model="form.pattern_size" :disabled="!canEdit" placeholder="如 M / 3M-6M-9M" /></div>
            <div class="fitem"><label>标签</label>
              <input class="input" v-model="form.label_name" :disabled="!canEdit" /></div>
            <div class="fitem"><label>预计完成 / 出样</label>
              <input class="input" type="date" v-model="form.due_date" :disabled="!canEdit" /></div>
            <div class="fitem"><label>作业时间（小时）</label>
              <input class="input" type="number" step="0.5" v-model.number="form.work_hours" :disabled="!canEdit" /></div>
            <div class="fitem"><label>实际用时（小时）</label>
              <input class="input" type="number" step="0.5" v-model.number="form.actual_hours" :disabled="!canEdit" /></div>
            <div class="fitem"><label>单价 / 工价</label>
              <input class="input" type="number" step="0.01" v-model.number="form.price" :disabled="!canEdit" /></div>
            <div class="fitem"><label>备注</label>
              <input class="input" v-model="form.remark" :disabled="!canEdit" /></div>

            <div v-for="fd in stageFields" :key="fd.k" class="fitem" :class="{ full: fd.type === 'text' }">
              <label>{{ fd.label }}</label>
              <textarea v-if="fd.type === 'text'" rows="3" v-model="form.data[fd.k]" :disabled="!canEdit"></textarea>
              <input v-else class="input" v-model="form.data[fd.k]" :disabled="!canEdit" />
            </div>

            <!-- 本阶段图片：可放多张（款式图、样衣照、纸样照…） -->
            <div class="fitem full">
              <label>
                图片
                <span class="img-hint">可放多张；点格子选中后 Ctrl+V 粘贴，或点右上角箭头选文件</span>
              </label>
              <div class="imgs">
                <div v-for="(img, i) in stageImages" :key="i" class="img-cell">
                  <ImageUpload
                    :model-value="img"
                    size="lg"
                    :disabled="!canEdit"
                    @update:model-value="(v) => setStageImage(i, v)"
                  />
                  <button  v-if="canEdit" class="img-del" type="button" @click="removeStageImage(i)">删除</button>
                </div>
                <button
                  v-if="canEdit && stageImages.length < 9"
                  class="img-add"
                  type="button"
                  @click="addStageImage"
                >
                  <span>＋</span>
                  <small>添加图片</small>
                </button>
              </div>
            </div>
          </div>

          </details>
          <!-- 全局资料：不管在哪个阶段，都能看到整份打版内容（只读） -->
          <div class="gp">
            <div class="gp-head">
              <strong>全局资料</strong>
              <span class="gp-sub">
                {{ gpSummary }}
              </span>
              <button class="link-btn" type="button" @click="gpOpen = !gpOpen">{{ gpOpen ? '收起' : '展开全部' }}</button>
            </div>

            <div v-show="gpOpen" class="gp-body">
              <!-- 面辅料（在面辅料确认阶段本身不重复显示） -->
              <div class="gp-block" v-if="cur.stage !== 'material'">
                <div class="gp-block-head">
                  <span>面辅料</span>
                  <span class="gp-meta">{{ materials.length }} 项<template v-if="matTotal"> · 单件成本 {{ money(matTotal) }} 元</template></span>
                </div>
                <div v-if="materials.length" class="gp-scroll">
                  <table class="data gp-tbl">
                    <thead>
                      <tr>
                        <th style="width: 50px">类型</th>
                        <th style="min-width: 160px">物料名称</th>
                        <th style="width: 80px">款色</th>
                        <th style="width: 130px">色号</th>
                        <th style="min-width: 110px">供应商</th>
                        <th style="width: 80px">使用部位</th>
                        <th style="width: 66px">用量</th>
                        <th style="width: 66px">单价</th>
                        <th style="width: 70px">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(m, i) in materials" :key="i">
                        <td><span class="tag" :class="m.mat_type === 'fabric' ? 'purple' : 'blue'">{{ m.mat_type === 'fabric' ? '面料' : '辅料' }}</span></td>
                        <td class="nm" :title="m.material_name">{{ m.material_name }}</td>
                        <td>{{ m.colorway || '-' }}</td>
                        <td>{{ m.color_no || '-' }}</td>
                        <td class="nm" :title="m.supplier">{{ m.supplier || '-' }}</td>
                        <td>{{ m.use_part || '-' }}</td>
                        <td>{{ m.one_use || '-' }}</td>
                        <td>{{ m.unit_price || '-' }}</td>
                        <td class="num">{{ money((m.one_use || 0) * (m.unit_price || 0)) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else class="gp-none">面辅料确认阶段还没填，物料清单是空的</div>
              </div>

              <!-- 各阶段填写的内容 -->
              <div class="gp-stages">
                <div
                  v-for="s in stages"
                  :key="s.key"
                  class="gp-stage"
                  :class="{ on: s.key === cur.stage, blank: !stageSummary(s.key).length }"
                >
                  <div class="gp-stage-head">
                    <strong>{{ s.label }}</strong>
                    <span class="tag" :class="stageTag(cur.flow.stage_map[s.key])">{{ stageStatusLabel(cur.flow.stage_map[s.key]) }}</span>
                  </div>
                  <div v-if="stageMeta(s.key)" class="gp-meta-line" :title="stageMeta(s.key)">{{ stageMeta(s.key) }}</div>
                  <div v-for="r in stageSummary(s.key)" :key="r.label" class="gp-kv" :class="{ full: r.full }">
                    <span>{{ r.label }}</span>
                    <b>{{ r.value }}</b>
                  </div>
                  <div v-if="!stageSummary(s.key).length" class="gp-none">还没填</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 面辅料确认：直接在下方的物料清单里从档案添加 -->
          <template v-if="cur.stage === 'material' && selectedTask('物料详情')">
            <div class="mat-notes">
              <div class="note-row">
                <label>面料补充说明（可空）</label>
                <input class="input" v-model="form.data.fabric_note" :disabled="!canEdit"
                       placeholder="如：色卡已寄客户确认，样布留档 A-01" />
              </div>
              <div class="note-row">
                <label>辅料补充说明（可空）</label>
                <input class="input" v-model="form.data.accessory_note" :disabled="!canEdit"
                       placeholder="如：拉链由客户指定 YKK，主唛需加防伪标" />
              </div>
            </div>

            <DevelopmentMaterials ref="referenceMaterials" :rows="materials" :colors="form.data.basic_info?.colors||cur.flow.colors||''" :readonly="!canEdit"/>

          </template>

          <!-- 工艺/工序明细：车缝工序 + 后整工序两张表 -->
          <template v-if="cur.stage === 'craft'">
            <div class="op" v-for="grp in opGroups" :key="grp.key">
              <div class="op-head">
                <strong>{{ grp.label }}</strong>
                <CraftCatalogPicker :disabled="!canEdit" :category="grp.key" @selected="addOpRow(grp.key, $event)" />
              </div>

              <div class="op-bar">
                <label>工价倍数</label>
                <input class="input op-ratio" type="number" step="0.1" :value="grpRatio(grp.key)"
                       :disabled="!canEdit" @input="setGrpRatio(grp.key, $event.target.value)" />
                <span class="op-tipnum">改这里会同步到本组所有行</span>
                <div style="flex: 1"></div>
                <button  class="btn btn-sm op-del" type="button" :disabled="!canEdit" @click="delCheckedOps(grp.key)">删除工序</button>
              </div>

              <div class="op-scroll">
                <table class="data op-tbl">
                  <thead>
                    <tr>
                      <th style="width: 34px"></th>
                      <th style="width: 46px">序号</th>
                      <th style="width: 92px">工序类别</th>
                      <th style="min-width: 150px">工序名称</th>
                      <th style="width: 82px">工序单价</th>
                      <th style="width: 76px">工价倍数</th>
                      <th style="width: 84px">倍率单价</th>
                      <th style="width: 84px">负责人</th>
                      <th style="min-width: 120px">备注</th>
                      <th style="width: 82px">开放单价</th>
                      <th style="width: 52px">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, i) in form.data[grp.key]" :key="i">
                      <td class="center"><input type="checkbox" v-model="row.checked" :disabled="!canEdit" /></td>
                      <td class="center">{{ i + 1 }}</td>
                      <td><input class="input mini" v-model="row.category" :disabled="!canEdit" /></td>
                      <td><input class="input mini" v-model="row.name" :disabled="!canEdit" placeholder="工序名称" /></td>
                      <td><input class="input mini" type="number" step="0.01" v-model.number="row.price" :disabled="!canEdit" /></td>
                      <td><input class="input mini" type="number" step="0.1" v-model.number="row.ratio" :disabled="!canEdit" /></td>
                      <td class="num">{{ money((row.price || 0) * (row.ratio || 0)) }}</td>
                      <td><input class="input mini" v-model="row.owner" :disabled="!canEdit" /></td>
                      <td><input class="input mini" v-model="row.remark" :disabled="!canEdit" /></td>
                      <td><input class="input mini" type="number" step="0.01" v-model.number="row.open_price" :disabled="!canEdit" /></td>
                      <td><button class="link-btn" type="button" :disabled="!canEdit || i === 0" @click="moveOpRow(grp.key, i, -1)">↑</button><button class="link-btn" type="button" :disabled="!canEdit || i === form.data[grp.key].length - 1" @click="moveOpRow(grp.key, i, 1)">↓</button><button class="link-btn danger" type="button" :disabled="!canEdit" @click="delOpRow(grp.key, i)">删</button></td>
                    </tr>
                    <tr v-if="!form.data[grp.key] || !form.data[grp.key].length">
                      <td colspan="11" class="empty-cell">暂无数据，从工序类别选择，或新建工序加入本款</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="op-foot">
                <button v-if="canEdit" class="op-add" type="button" @click="addOpRow(grp.key)">＋ 添加一行数据</button>
                <span class="op-sum">
                  {{ (form.data[grp.key] || []).length }} 道工序 · 倍率单价合计
                  <strong>{{ money(opTotal(grp.key)) }}</strong> 元
                </span>
              </div>
            </div>
          </template>

          <!-- 已归档时只说「锁定」，不要误报成「没权限」 -->
          <div v-if="cur.flow.change_hold" class="tip-warn">
            业务信息修改正在审核；同意修改后还需再次审核，通过前打版流程暂停。
          </div>
          <div v-else-if="!canEdit && cur.flow.status !== 'done'" class="tip-warn">
            你的角色（{{ roleLabel }}）在这个阶段没有填写权限，当前仅可查看。
          </div>
          <div v-if="cur.flow.status === 'done'" class="tip-warn">
            该打版流程已完成，样衣已归档锁定。如需修改，请到「样衣管理」提交更改需求。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeStage">关闭</button>
          <button v-if="can('order.create') && cur.flow.status === 'running'" class="btn btn-ghost" :disabled="busy || cur.flow.change_hold" @click="openChangeRequest">申请修改业务信息</button>
          <button v-if="canEdit && cur.flow.status !== 'done'" class="btn btn-ghost" @click="reopen">退回重做</button>
          <button v-if="canEdit && cur.flow.status !== 'done'" class="btn btn-ghost" :disabled="busy" @click="save">保存</button>
          <button v-if="canEdit && cur.flow.status !== 'done'" class="btn btn-primary" :disabled="busy || stageDone" @click="done">
            {{ stageDone ? '本阶段已完成' : '完成本阶段' }}
          </button>
          <button v-if="canFinish" class="btn btn-primary" :disabled="busy" @click="finish">
            完成打版并归档样衣
          </button>
        </div>
      </div>
    </div>
    <div v-if="changeOpen && cur" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>申请修改打版信息</h3><button class="x" @click="changeOpen = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full"><label>申请修改的信息项</label><select class="input" v-model="changeForm.field_key"><option v-for="field in changeFields" :key="field.key" :value="field.key">{{ field.label }}</option></select></div>
            <div class="fitem full"><label>修改原因 *</label><textarea v-model="changeForm.reason" rows="2" placeholder="如：客户确认后调整面料成分或尺码要求"></textarea></div>
            <div class="fitem full"><label>修改后的内容 *</label><textarea v-model="changeForm.proposed_value" rows="4" placeholder="填写审核通过后要采用的新内容"></textarea></div>
          </div>
          <p class="tip-warn">提交后立即暂停打版。技术同意修改后，系统应用新内容并再次等待技术复核。</p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="changeOpen = false">取消</button><button class="btn btn-primary" :disabled="busy" @click="submitChangeRequest">提交审核</button></div>
      </div>
    </div>
  </div>
</template>
</template>

<script setup>
import {openImage} from '../store/viewer';
import PatternManagement from '../components/PatternManagement.vue';
import PatternTaskBasics from '../components/PatternTaskBasics.vue';
import DevelopmentMaterials from '../components/DevelopmentMaterials.vue';
import SampleWorkbench from '../components/SampleWorkbench.vue';
import CraftCatalogPicker from '../components/CraftCatalogPicker.vue';
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import { can,canAction,permState } from '../store/permissions';
import MaterialPicker from '../components/MaterialPicker.vue';
import ImageUpload from '../components/ImageUpload.vue';
import { fmtTime } from '../utils/time';
import { auth, ROLE_LABELS } from '../store/auth';

const STAGE_FIELDS = {
  // 面料 / 辅料补充说明不在这里渲染：跟着平铺勾选区走，见模板里 material 段
  material: [],
  pattern: [
    { k: 'style_no', label: '款号（版房填写）' },
    { k: 'pattern_no', label: '纸样号' },
    { k: 'version_note', label: '版型说明', type: 'text' }
  ],
  craft: [
    { k: 'process_note', label: '工序要求', type: 'text' }
  ],
  sample: [
    { k: 'sample_qty', label: '样衣件数' },
    { k: 'sample_result', label: '车板结果', type: 'text' }
  ],
  biz: [
    { k: 'customer_opinion', label: '客户意见', type: 'text' },
    { k: 'confirmed_by_customer', label: '客户确认人' }
  ],
  audit: [
    { k: 'cost_detail', label: '工价明细', type: 'text' },
    { k: 'approved_price', label: '核定工价' }
  ]
};

const managementRef=ref(null),boardConfig=ref({stages:[],tasks:{},urgencies:[]});
function taskBadge(f){const task=boardConfig.value.tasks[f.id];return boardConfig.value.urgencies.find(u=>u.name===task?.urgency);}
function selectedTask(name){const tasks=boardConfig.value.stages.find(s=>s.key===cur.value?.stage)?.tasks;return !tasks?.length||tasks.includes(name);}
const stages = ref([]);
function applyBoardConfig(c){boardConfig.value=c;if(c.stages?.length)stages.value=stages.value.map(s=>({...s,label:c.stages.find(t=>t.key===s.key)?.label||s.label}));}
const flows = ref([]);
const q = ref('');
// 看板与归档列共用筛选口径；各列款号搜索只影响本列。
const boardFilters = ref({ customer: '', patternOwner: '', sampleOwner: '', label: '', due: '', hold: '', designer:'', brand:'', salesperson:'', category:'' });
const referenceFilters=[['designer','设计师'],['brand','品牌'],['salesperson','业务员'],['category','品类']];
const columnQueries = ref({});
function resetBoardFilters() {
  q.value = '';
  Object.keys(boardFilters.value).forEach(key => { boardFilters.value[key] = ''; });
  columnQueries.value = {};
}
function printPattern(f){window.open('/print?type=techpack&id='+encodeURIComponent(f.tech_pack_id),'_blank','noopener');}
function boardOwners(stage) {
  return [...new Set(flows.value.map(f => f.stage_map[stage]?.owner).filter(Boolean))];
}
function matchesBoard(f) {
  const contains = (value, keyword) => String(value || '').toLowerCase().includes(keyword.trim().toLowerCase());
  const filter = boardFilters.value;
  if (q.value.trim() && ![f.customer_style_no, f.product_name, f.order_no, f.customer_name].some(v => contains(v, q.value))) return false;
  if (!contains(f.customer_name, filter.customer) || !contains(f.stage_map.pattern?.owner, filter.patternOwner) || !contains(f.stage_map.sample?.owner, filter.sampleOwner)) return false;
  for(const [key] of referenceFilters){if(filter[key]?.trim()&&!f.stages.some(s=>contains(s.data?.basic_info?.[key],filter[key])))return false;}
  if (filter.label.trim() && !f.stages.some(s => contains(s.label_name, filter.label))) return false;
  if (filter.due && !f.stages.some(s => s.due_date === filter.due)) return false;
  if (filter.hold === 'hold' && !f.change_hold || filter.hold === 'active' && f.change_hold) return false;
  return true;
}
function matchesColumn(f, key) {
  const keyword = (columnQueries.value[key] || '').trim().toLowerCase();
  return !keyword || [f.customer_style_no, f.product_name].some(v => String(v || '').toLowerCase().includes(keyword));
}
const show = ref('all');
const boardTab=ref('all');
const visibleBoardStages=computed(()=>stages.value.filter(s=>boardTab.value===s.key||boardTab.value==='all'&&colCards(s.key).length));
const cur = ref(null);
const form = ref(blankForm());
const changeOpen = ref(false);
const changeForm = ref({ field_key: 'customer_req', reason: '', proposed_value: '' });
const changeFields = [
  { key: 'customer_req', label: '客户要求' }, { key: 'fabric_info', label: '面料信息' },
  { key: 'accessory_info', label: '辅料信息' }, { key: 'craft_info', label: '工艺要求' },
  { key: 'size_spec', label: '尺码规格' }
];
const busy = ref(false);
const dirty = ref(false);
let formSilent = false;
// 表单任何改动都记为「未保存」，用于切换阶段 / 关闭时提醒
watch(form, () => { if (!formSilent) dirty.value = true; }, { deep: true });
const referenceMaterials=ref(null);
const materials = ref([]);
const pickerOpen = ref(false);
const pickerType = ref('fabric');
const gpOpen = ref(false);
const opGroups = [
  { key: 'sewing', label: '车缝工序', cat: '车缝' },
  { key: 'finish', label: '后整工序', cat: '后整' }
];
const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
const matTotal = computed(() => materials.value.reduce((s, m) => s + (Number(m.one_use) || 0) * (Number(m.unit_price) || 0), 0));

const router = useRouter();
const route = useRoute();
/** 已完成卡片 → 样衣档案（带上款号做筛选） */
function goSample(f) {
  router.push({ path: '/sample-archive', query: { q: f.customer_style_no || f.product_name || '' } });
}

const roleLabel = computed(() => ROLE_LABELS[auth.user?.role] || auth.user?.role || '-');
const runningCount = computed(() => flows.value.filter((f) => f.status === 'running').length);
const doneCount = computed(() => flows.value.filter((f) => f.status === 'done').length);
/**
 * 已完成列不受「进行中 / 已完成」筛选影响：
 * 原来取 filtered，切到「进行中」时这一列永远是空的，看着像坏了。
 * 客户、人员、标签与日期筛选同时作用于归档列。
 */
const doneFlows = computed(() => {
  return flows.value.filter(f => f.status === 'done' && matchesBoard(f) && matchesColumn(f, 'done'));
});

const filtered = computed(() => {
  let list = flows.value;
  if (show.value === 'running') list = list.filter((f) => f.status === 'running');
  else if (show.value === 'done') list = list.filter((f) => f.status === 'done');
  return list.filter(matchesBoard);
});

const stageFields = computed(() => (cur.value ? STAGE_FIELDS[cur.value.stage] || [] : []));
const canEdit = computed(() => !!(cur.value && cur.value.flow.status !== 'done' && !cur.value.flow.change_hold && (permState.positionDirect?canAction('pattern-flows','stage'):can('pattern.' + cur.value.stage))));
const canFinish = computed(() => {
  if (!cur.value) return false;
  const f = cur.value.flow;
  if (f.status === 'done' || f.change_hold) return false;
  const allDone = stages.value.every((s) => f.stage_map[s.key].status === 'done');
  return allDone && (permState.positionDirect?canAction('pattern-flows','finish'):can('pattern.audit'));
});

function blankForm() {
  return { owner: '', pattern_size: '', label_name: '', due_date: '', work_hours: 0, actual_hours: 0, price: 0, remark: '', data: {} };
}

const stageLabel = (k) => (stages.value.find((s) => s.key === k) || {}).label || k;
const stageTag = (d) => (d && d.status === 'done' ? 'green' : d && d.status === 'doing' ? 'orange' : 'gray');
const stageStatusLabel = (d) => (d && d.status === 'done' ? '已完成' : d && d.status === 'doing' ? '进行中' : '待开始');
const changeFieldLabel = (key) => key==='development_submission'?'开发资料准入审核':key==='development_revision'?'业务开发资料改版':(changeFields.find((f) => f.key === key) || {}).label || key;
const changeStatusLabel = (s) => ({ editing:'业务修改中', pending: '待审核修改', awaiting_recheck: '修改后待复核', released: '复核通过', rejected: '已驳回' }[s] || s);
const changeStatusTag = (s) => ({ pending: 'orange', awaiting_recheck: 'purple', released: 'green', rejected: 'red' }[s] || 'gray');

const runningFlows = computed(() => filtered.value.filter((f) => f.status === 'running'));
/** 每列只放「当前阶段正好停在这一步」的流程，避免同一单子重复出现在后续列 */
function colCards(stageKey) {
  return runningFlows.value.filter((f) => f.current_stage === stageKey && matchesColumn(f, stageKey));
}
function countByStage(stageKey) {
  return colCards(stageKey).length;
}
/** 顶部流程条点亮条件：当前筛选下所有在跑流程都已过这一步 */
function stepDone(k) {
  // 用全量进行中流程算，避免切到「已完成」筛选后整条流程条变灰
  const list = flows.value.filter((f) => f.status === 'running');
  if (!list.length) return false;
  return list.every((f) => f.stage_map[k] && f.stage_map[k].status === 'done');
}
/** 收起时也能看个大概：面辅料几项 + 走到第几步 */
const gpSummary = computed(() => {
  if (!cur.value) return '';
  const done = stages.value.filter((s2) => cur.value.flow.stage_map[s2.key] && cur.value.flow.stage_map[s2.key].status === 'done').length;
  const mat = materials.value.length;
  return `面辅料 ${mat} 项${mat ? '（单件 ' + money(matTotal.value) + ' 元）' : ''} · 已完成 ${done}/6 阶段 · 点右上角展开看全部填写内容`;
});

/** 各阶段共有的基础信息压成一行，避免六张卡重复同样四行 */
function stageMeta(key) {
  if (!cur.value) return '';
  const sm = cur.value.flow.stage_map[key];
  if (!sm) return '';
  return [sm.owner, sm.pattern_size, sm.label_name, sm.due_date].filter(Boolean).join(' · ');
}

/** 各阶段已填内容的摘要，给「全局资料」用；空值不显示 */
function stageSummary(key) {
  if (!cur.value) return [];
  const sm = cur.value.flow.stage_map[key];
  if (!sm) return [];
  const d = sm.data || {};
  const rows = [];
  const push = (label, v, full) => {
    if (v === '' || v === null || v === undefined || v === 0) return;
    rows.push({ label, value: String(v), full: !!full });
  };
  push('作业时间', sm.work_hours ? sm.work_hours + ' 小时' : '');
  push('实际用时', sm.actual_hours ? sm.actual_hours + ' 小时' : '');
  push('单价 / 工价', sm.price ? '¥' + sm.price : '');
  push('备注', sm.remark, true);
  (STAGE_FIELDS[key] || []).forEach((f) => push(f.label, d[f.k], f.type === 'text'));
  // 面辅料阶段的两个说明不在 STAGE_FIELDS 里（跟着清单走）
  if (key === 'material') {
    push('面料补充说明', d.fabric_note, true);
    push('辅料补充说明', d.accessory_note, true);
  }
  // 工序表：给个行数 + 倍率单价合计，具体明细点开本阶段看
  if (key === 'craft') {
    const opSum = (list) => (list || []).reduce((n, r) => n + (Number(r.price) || 0) * (Number(r.ratio) || 0), 0);
    if ((d.sewing || []).length) {
      push('车缝工序', `${d.sewing.length} 道 · 倍率单价合计 ¥${Math.round(opSum(d.sewing) * 100) / 100}`);
    }
    if ((d.finish || []).length) {
      push('后整工序', `${d.finish.length} 道 · 倍率单价合计 ¥${Math.round(opSum(d.finish) * 100) / 100}`);
    }
  }
  return rows;
}

/** 弹窗里当前这一步是否已完成（完成后不让人重复点） */
const stageDone = computed(() => !!(cur.value && cur.value.data && cur.value.data.status === 'done'));

/** 点顶部流程条：滚到对应看板列并闪一下 */
function jumpToStage(k) {
  const idx = stages.value.findIndex((s) => s.key === k);
  const col = document.querySelectorAll('.pboard .pcol')[idx];
  if (!col) return;
  col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  col.classList.add('flash');
  setTimeout(() => col.classList.remove('flash'), 900);
}

/** 弹窗内切阶段（同一张流程），有未保存改动先问一声 */
function switchStage(k) {
  if (!cur.value || k === cur.value.stage) return;
  if (dirty.value && !confirm('当前阶段有未保存的修改，切换后会丢失，继续？')) return;
  openStage(cur.value.flow, k);
}

function closeStage() {
  if (dirty.value && !confirm('有未保存的修改，确定关闭？')) return;
  cur.value = null;
}

async function load() {
  try {
    const d = await api.patternBoard();
    stages.value = d.stages;
    flows.value = d.flows;
  } catch (e) { alert(e.message); }
}

/** 档案 → 本阶段物料行：档案字段只读，其余在本阶段填 */
function rowFromArchive(a) {
  const spec = [];
  if (a.width) spec.push('幅宽' + a.width);
  if (a.weight) spec.push('克重' + a.weight);
  if (a.air_gap) spec.push('空差' + a.air_gap);
  if (a.spec) spec.push(a.spec);
  const gap = Number(String(a.air_gap || '').replace(/[^\d.]/g, ''));
  return {
    material_id: a.id,
    mat_type: a.type,
    colorway: '',
    material_name: a.name,
    color_no: '',
    supplier: a.supplier || '',
    supplier_info: a.supplier_info || '',
    spec_info: spec.length ? spec.join(' ') : (a.spec || ''),
    composition: a.composition || '',
    unit: a.unit || '',
    fabric_param: a.spec || '',
    use_part: '',
    one_use: 0, loss_rate: 0, air_gap: Number.isFinite(gap) ? gap : 0, unit_price: 0,
    remark: '', image_url: a.image_url || '', color_card_url: ''
  };
}
function onPicked(rows) {
  let added = 0, dup = 0;
  (rows || []).forEach((a) => {
    if (materials.value.some((m) => m.material_id === a.id)) { dup++; return; }
    materials.value.push(rowFromArchive(a));
    added++;
  });
  // 重复时不吭声会让人以为「点了加入没反应」
  if (!added && dup) alert('这几条物料已经在清单里了，直接在上面填用量即可');
  else if (added && dup) alert(`已加入 ${added} 条，另有 ${dup} 条已在清单里已跳过`);
}
function delMat(i) { materials.value.splice(i, 1); }
function openPicker(t) { pickerType.value = t; pickerOpen.value = true; }

async function loadMaterials(flowId) {
  try { const d = await api.patternMaterials(flowId); materials.value = d.materials || []; }
  catch (e) { materials.value = []; }
}
async function saveMaterialsIfNeeded() {
  if (!cur.value || cur.value.stage !== 'material') return;
  await api.savePatternMaterials(cur.value.flow.id, referenceMaterials.value?.serialize()||materials.value);
}

/** 阶段数据兜底：图片、车缝/后整工序都要是数组 */
function withImages(d) {
  const data = { ...(d || {}) };
  if (!Array.isArray(data.images)) data.images = [];
  if (!Array.isArray(data.sewing)) data.sewing = [];
  if (!Array.isArray(data.finish)) data.finish = [];
  return data;
}

/* ---------- 工序表 ---------- */
const CAT_LABEL = {
  sewing: '车缝', print: '印花', embroidery: '绣花', wash: '水洗',
  finish: '后整', pack: '包装', other: '其他'
};
const grpCat = (k) => (opGroups.find((g) => g.key === k) || {}).cat || '';
const grpRatio = (k) => {
  const v = form.value.data[k + '_ratio'];
  return v === undefined || v === null ? 1 : v;
};
/** 顶部统一倍数：同步到本组所有行 */
function setGrpRatio(k, v) {
  const r = Number(v);
  form.value.data[k + '_ratio'] = Number.isFinite(r) ? r : 1;
  (form.value.data[k] || []).forEach((row) => { row.ratio = form.value.data[k + '_ratio']; });
}
/** 添加一行：带模板时用工序档案的名称与默认单价 */
function addOpRow(k, tpl) {
  const list = form.value.data[k];
  if (!Array.isArray(list)) return;
  list.push({
    checked: false,
    craft_type_id: tpl?.id || null,
    unit: tpl?.unit || '件',
    image_url: tpl?.image_url || '',
    category: tpl && tpl.category ? (CAT_LABEL[tpl.category] || tpl.category) : grpCat(k),
    name: tpl ? tpl.name : '',
    price: tpl ? Number(tpl.default_price) || 0 : 0,
    ratio: grpRatio(k),
    owner: '',
    remark: tpl?.remark || '',
    open_price: 0
  });
}
function moveOpRow(k, i, delta) {
  if (!canEdit.value) return;
  const rows = form.value.data[k], next = i + delta;
  if (next < 0 || next >= rows.length) return;
  [rows[i], rows[next]] = [rows[next], rows[i]];
}
function delOpRow(k, i) { form.value.data[k].splice(i, 1); }
function delCheckedOps(k) {
  const list = form.value.data[k] || [];
  const left = list.filter((r) => !r.checked);
  if (left.length === list.length) return alert('先勾选要删除的工序');
  form.value.data[k] = left;
}
function opTotal(k) {
  return (form.value.data[k] || []).reduce((s2, r) => s2 + (Number(r.price) || 0) * (Number(r.ratio) || 0), 0);
}

const stageImages = computed(() => (form.value.data && Array.isArray(form.value.data.images) ? form.value.data.images : []));
function addStageImage() {
  if (!form.value.data.images) form.value.data.images = [];
  form.value.data.images.push('');
}
function setStageImage(i, v) {
  form.value.data.images[i] = v;
  // 清空后不再占一个空位
  if (!v) form.value.data.images.splice(i, 1);
}
function removeStageImage(i) { form.value.data.images.splice(i, 1); }

/** 服务端阶段数据 → 表单；置位 formSilent 避免被 dirty 监听误判 */
function fillForm(sm) {
  const d = sm || {};
  formSilent = true;
  form.value = {
    owner: d.owner || '',
    pattern_size: d.pattern_size || '',
    label_name: d.label_name || '',
    due_date: d.due_date || '',
    work_hours: d.work_hours || 0,
    actual_hours: d.actual_hours || 0,
    price: d.price || 0,
    remark: d.remark || '',
    data: withImages(d.data)
  };
  nextTick(() => { formSilent = false; dirty.value = false; });
}

function openStage(f, stageKey) {
  const sm = f.stage_map[stageKey] || {};
  cur.value = { flow: f, stage: stageKey, data: sm };
  fillForm(sm);
  if(stageKey==='pattern'){form.value.data.style_no=f.customer_style_no||'';form.value.data.style_no_version=f.style_no_version;}
  materials.value = [];
  // 每个阶段都要能看到面辅料（全局资料），不只面辅料确认阶段
  loadMaterials(f.id);
}

async function save() {
  if (!cur.value) return;
  busy.value = true;
  try {
    await saveMaterialsIfNeeded();
    await api.savePatternStage(cur.value.flow.id, cur.value.stage, form.value);
    const label = stageLabel(cur.value.stage);
    await load();
    dirty.value = false;
    cur.value = null;          // 保存完就关，不用留着
    alert(`「${label}」已保存`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function done() {
  if (!cur.value) return;
  if (stageDone.value) return alert('本阶段已完成，如需重填请点「退回重做」');
  const label = stageLabel(cur.value.stage);
  if (!confirm(`确认「${label}」阶段已完成？完成后将锁定本阶段并进入下一步。`)) return;
  busy.value = true;
  try {
    await saveMaterialsIfNeeded();
    await api.savePatternStage(cur.value.flow.id, cur.value.stage, form.value);
    const r = await api.donePatternStage(cur.value.flow.id, cur.value.stage);
    await load();
    dirty.value = false;
    const nx = r && r.flow && r.flow.current_stage;
    cur.value = null;          // 完成后关弹窗，看板上的卡片会自己挪到下一列

    if (r && r.finished) {
      alert(`「${label}」已完成 —— 六个阶段全部走完，再点开卡片即可「完成打版并归档样衣」`);
      return;
    }
    alert(`「${label}」已完成，已流转到「${stageLabel(nx) || '下一阶段'}」`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

function openChangeRequest() {
  changeForm.value = { field_key: 'customer_req', reason: '', proposed_value: '' };
  changeOpen.value = true;
}
async function refreshCurrentFlow() {
  const flowId = cur.value?.flow?.id, stageKey = cur.value?.stage;
  await load();
  const latest = flows.value.find((f) => f.id === flowId);
  if (latest) openStage(latest, stageKey);
}
async function submitChangeRequest() {
  if (!changeForm.value.reason.trim() || !changeForm.value.proposed_value.trim()) return alert('请填写修改原因和修改后的内容');
  busy.value = true;
  try {
    await api.createPatternChangeRequest(cur.value.flow.id, changeForm.value);
    changeOpen.value = false;
    dirty.value = false;
    await refreshCurrentFlow();
    alert('修改申请已提交，打版流程已暂停，等待技术审核');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}
async function reviewChange(change, approve) {
  const note = window.prompt(approve ? '审核意见（可空）' : '请填写驳回原因：');
  if (note === null || (!approve && !note.trim())) return;
  busy.value = true;
  try {
    await api.reviewPatternChangeRequest(change.id, { approve, note: note.trim() });
    await refreshCurrentFlow();
    alert(approve ? '修改已同意并应用，流程继续暂停，等待修改后复核' : '修改申请已驳回，原打版信息保留');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}
async function recheckChange(change, approve) {
  const note = window.prompt(approve ? '修改后复核意见（可空）' : '请填写复核未通过原因：');
  if (note === null || (!approve && !note.trim())) return;
  busy.value = true;
  try {
    await api.recheckPatternChangeRequest(change.id, { approve, note: note.trim() });
    await refreshCurrentFlow();
    alert(approve ? '修改后复核通过，打版流程已恢复' : '修改后复核未通过，系统已恢复原信息');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function reopen() {
  if (!cur.value) return;
  const label = stageLabel(cur.value.stage);
  const isCurrent = cur.value.flow.current_stage === cur.value.stage;
  const msg = isCurrent
    ? `「${label}」就是当前正在做的阶段（还没完成）。退回会清空本阶段已填内容和完成状态，之后要重新填一遍，确认？`
    : `退回「${label}」重做？该阶段及之后（${nextStagesText(cur.value.stage)}）的完成状态都会重置。`;
  if (!confirm(msg)) return;
  busy.value = true;
  try {
    await api.reopenPatternStage(cur.value.flow.id, cur.value.stage);
    await load();
    dirty.value = false;
    cur.value = null;
    alert(`已退回「${label}」，当前从这一步重新开始（状态：进行中）`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

/** 「制版、工艺明细…」——退回提示里列一下会被重置的后续阶段 */
function nextStagesText(stageKey) {
  const idx = stages.value.findIndex((s) => s.key === stageKey);
  return stages.value.slice(idx + 1).map((s) => s.label).join('、') || '无后续阶段';
}

async function finish() {
  if (!cur.value) return;
  if (!confirm('完成打版并归档样衣？归档后样衣锁定，修改需提交变更需求。')) return;
  busy.value = true;
  try {
    const r = await api.finishPatternFlow(cur.value.flow.id);
    await load();
    cur.value = null;
    alert('打版完成，已归档样衣：' + (r.archive ? r.archive.archive_no : ''));
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(async()=>{await load();if(route.query.techpack){const f=flows.value.find(x=>Number(x.tech_pack_id)===Number(route.query.techpack));if(f)openStage(f,f.status==='done'?'audit':f.current_stage||'material');}});
</script>

<style scoped>
.pattern-filters { display:flex; flex-wrap:wrap; align-items:end; gap:12px 18px; padding:16px; margin-bottom:14px; border:1px solid var(--line); background:var(--surface); border-radius:8px; }
.pattern-filters label { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--ink-mute); }
.pattern-filters .input { width:170px; }
.pattern-workspace .pboard { gap:14px; border:1px solid var(--line); padding:12px; background:var(--surface); border-radius:8px; }
.pattern-workspace .pcol { width:310px; background:var(--surface-2); border:1px solid var(--line); border-radius:6px; }
.pattern-workspace .pcol-head { padding:8px 4px 12px; font-size:14px; }
.pcol-search { margin-bottom:10px; width:100%; }
.pattern-workspace .pcard { padding:12px; border-color:var(--line); border-radius:5px; }
.pattern-workspace .pline { color:var(--ink-mute); line-height:1.9; }
.pattern-workspace .pcount, .pattern-workspace .flow-step, .pattern-workspace .flow-step .cnt, .pattern-workspace .flow-step .dot { color:var(--ink-mute); background:var(--surface); border-color:var(--line); }
.pattern-card-image { width:100%; height:150px; object-fit:contain; background:var(--surface-2); margin:5px 0 10px; }
.pattern-time { display:block; color:var(--ink-mute); font-size:11px; line-height:1.8; }
@media(max-width:720px) { .pattern-filters label { width:100%; justify-content:space-between; } .pattern-filters .input { width:70%; } }
.flow-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.flow-step {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px 6px 6px;
  border: 1px solid #e6ebf3; border-radius: 22px; font-size: 12.5px; color: #5b6474; background: var(--surface);
  cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
}
.flow-step:hover { border-color: #2b6de5; box-shadow: 0 2px 8px rgba(43, 109, 229, 0.12); }
.flow-step.done { color: #1a7f4b; border-color: #cfe9da; background: #f5fbf7; }
.flow-step.done .dot { background: #1a7f4b; }
.pcol.flash { animation: colFlash 0.9s ease; }
@keyframes colFlash {
  0% { box-shadow: 0 0 0 0 rgba(43, 109, 229, 0.5); }
  40% { box-shadow: 0 0 0 4px rgba(43, 109, 229, 0.25); }
  100% { box-shadow: 0 0 0 0 rgba(43, 109, 229, 0); }
}
.flow-step .dot {
  width: 20px; height: 20px; border-radius: 50%; background: #eef2f7; color: var(--ink-mute);
  display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
}
.flow-step .lbl { font-weight: 600; color: var(--ink); }
.flow-step .cnt { background: #eef2f7; color: #5b6474; border-radius: 9px; padding: 0 6px; font-size: 12px; }
.flow-step.end { border-style: dashed; }

.pboard { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 10px; align-items: flex-start; }
.pcol { width: 232px; flex: none; background: #f6f8fc; border-radius: 12px; padding: 8px; }
.pcol-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12.5px; font-weight: 700; color: var(--ink); padding: 4px 6px 8px;
}
.pcount { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 9px; padding: 0 6px; font-size: 12px; color: #5b6474; }
.pcol-body { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; }

.pcard { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 10px; padding: 9px 10px; cursor: pointer; }
.pcard:hover { border-color: #b9ceff; box-shadow: 0 2px 10px rgba(43, 109, 229, 0.08); }
.pcard.done { cursor: default; }
.pcard-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 5px; }
.pstyle { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pline { font-size: 12px; color: #5b6474; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pline.muted { color: var(--ink-mute); }
.pmeta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; font-size: 12px; color: var(--ink-mute); }
.pacts { margin-top: 6px; border-top: 1px dashed var(--line); padding-top: 5px; }
.pempty { text-align: center; color: #c2ccdb; font-size: 12px; padding: 14px 0; }

.op { border: 1px solid #e6ebf3; border-radius: 12px; background: var(--surface); margin: 12px 0; padding: 10px 12px; }
.op-head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.op-head strong { flex: none; font-size: 13px; color: var(--ink); padding-top: 3px; }
.op-quick { flex: 1; font-size: 12px; color: var(--ink-mute); line-height: 2; }
.op-tag {
  border: 1px solid #e2e8f2; background: var(--surface-2); border-radius: 4px; padding: 1px 7px;
  font-size: 12px; color: var(--ink); cursor: pointer; margin: 0 2px 2px 0;
}
.op-tag:hover { border-color: #2b6de5; color: var(--brand); background: #eef4ff; }
.op-tag:disabled { cursor: default; opacity: 0.55; }
.op-none { font-size: 12px; color: #b6bfcd; }
.op-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.op-bar label { font-size: 12.5px; color: #5b6474; }
.op-ratio { width: 92px; }
.op-tipnum { font-size: 12px; color: var(--ink-mute); }
.op-del { background: #fdecee; color: #d92d45; border: 1px solid #f8d3d8; }
.op-del:hover { background: #fbdde1; }
.op-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.op-tbl { border: none; min-width: 1020px; }
.op-tbl th, .op-tbl td { padding: 4px 6px; font-size: 12px; white-space: nowrap; }
.op-tbl .input.mini { width: 100%; padding: 3px 6px; font-size: 12px; }
.op-tbl td.center { text-align: center; }
.op-tbl td.num { text-align: right; font-weight: 600; }
.op-tbl .empty-cell { text-align: center; color: var(--ink-mute); padding: 10px; }
.op-foot { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.op-add {
  border: 1px dashed #cdd7e5; background: var(--surface-2); border-radius: 8px; padding: 6px 14px;
  font-size: 12.5px; color: var(--brand); cursor: pointer; width: 100%;
}
.op-add:hover { border-color: #2b6de5; background: #f3f7ff; }
.op-sum { flex: none; font-size: 12px; color: #5b6474; }
.op-sum strong { color: var(--ink); }
.img-hint { font-weight: 400; font-size: 12px; color: var(--ink-mute); margin-left: 8px; }
.imgs { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
.img-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.img-cell .img-del { border: none; background: none; padding: 0; font-size: 12px; color: #e5484d; cursor: pointer; }
.img-add {
  width: 96px; height: 96px; border: 1px dashed #d5dde9; border-radius: 10px; background: var(--surface-2);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  color: var(--ink-mute); cursor: pointer; font-size: 18px;
}
.img-add small { font-size: 12px; }
.img-add:hover { border-color: #2b6de5; color: var(--brand); }
.gp { border: 1px solid #e6ebf3; border-radius: 12px; background: #fafbfd; margin-bottom: 14px; }
.gp-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--line); }
.gp-head strong { font-size: 13px; color: var(--ink); }
.gp-sub { flex: 1; font-size: 12px; color: var(--ink-mute); }
.gp-body { padding: 10px 14px 12px; max-height: 34vh; overflow-y: auto; }
.gp-block-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.gp-block-head > span:first-child { font-size: 12.5px; font-weight: 700; color: var(--ink); }
.gp-meta { font-size: 12px; color: var(--brand); }
.gp-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); max-height: 168px; overflow-y: auto; }
.gp-tbl { border: none; min-width: 860px; }
.gp-tbl th, .gp-tbl td { padding: 4px 8px; font-size: 12px; white-space: nowrap; }
.gp-tbl td.num { text-align: right; font-weight: 600; }
.gp-tbl td.nm { max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
.gp-tbl .empty-cell { text-align: center; color: var(--ink-mute); }
.gp-stages { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; margin-top: 10px; }
.gp-stage { background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; }
.gp-stage.on { border-color: #2b6de5; box-shadow: 0 0 0 2px rgba(43, 109, 229, 0.08); }
.gp-stage.blank { opacity: 0.7; }
.gp-stage-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.gp-stage-head strong { font-size: 12px; color: var(--ink); }
.gp-meta-line {
  font-size: 12px; color: var(--ink-mute); margin: -2px 0 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-kv { display: flex; gap: 8px; font-size: 12px; line-height: 1.6; }
.gp-kv span { flex: none; width: 88px; color: var(--ink-mute); }
.gp-kv b { color: var(--ink); font-weight: 500; word-break: break-all; }
.gp-kv.full { flex-direction: column; gap: 1px; }
.gp-kv.full span { width: auto; }
.gp-kv.full b { white-space: pre-wrap; }
.gp-none { font-size: 12px; color: #b6bfcd; }
.stage-strip { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.stage-strip .ss {
  font-size: 12px; color: var(--ink-mute); background: #f6f8fc; border-radius: 12px; padding: 3px 9px;
}
.stage-strip .ss.done { background: #e6f7ec; color: #16a34a; }
.stage-strip .ss.jump { cursor: pointer; }
.stage-strip .ss.jump:hover { border-color: #2b6de5; color: var(--brand); }
.ss.on { background: #e8f0ff; color: var(--brand); font-weight: 700; }
.modal.xwide.pb-modal { width: 1460px; max-width: 97vw; }
.pb-modal .modal-body { max-height: 82vh; }
.mat-notes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin: 14px 0 4px; }
@media (max-width: 1100px) { .mat-notes { grid-template-columns: 1fr; } }
.note-row { display: flex; align-items: center; gap: 10px; margin: 0; }
.note-row label { flex: none; width: 142px; white-space: nowrap; font-size: 12.5px; color: #5b6474; }
.note-row .input { flex: 1; }
.mat-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 16px 0 8px; flex-wrap: wrap; }
.mat-head h4 { margin: 0; font-size: 13px; color: var(--ink); }
.mat-head .hint { font-weight: 400; font-size: 12px; color: var(--ink-mute); margin-left: 6px; }
.mat-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.mat-tbl { border: none; min-width: 1700px; }
.mat-tbl th, .mat-tbl td { white-space: nowrap; padding: 5px 6px; font-size: 12px; vertical-align: middle; }
.mat-tbl .input.mini { width: 100%; padding: 4px 6px; font-size: 12px; }
.mat-tbl td.num { text-align: right; font-weight: 600; color: var(--ink); }
.mat-tbl .locked { font-size: 12px; color: var(--ink); line-height: 1.35; max-width: 200px; }
.mat-tbl .locked.center { text-align: center; }
.mat-tbl .locked .sub { font-size: 12px; color: var(--ink-mute); max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-tbl .lock { font-size: 12px; margin-right: 3px; opacity: 0.5; }
.mat-tbl tr.from-arc td { background: var(--surface-2); }
.mat-sum { margin-top: 6px; font-size: 12.5px; color: #5b6474; }
.tip-warn {
  margin-top: 10px; background: #fff8e6; border: 1px solid #ffe0a3; color: #b26a00;
  border-radius: 8px; padding: 8px 10px; font-size: 12px;
}
.change-hold-badge{margin:7px 0;padding:6px 8px;border-radius:6px;background:#fff4df;color:#9b6208;font-size:12px}.change-panel{border:1px solid #f0dba9;background:#fffdf7;border-radius:10px;padding:11px 12px;margin:0 0 13px}.change-panel-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}.change-panel-head strong{font-size:12px;color:#73520b}.change-panel-head span{font-size:12px;color:#927c51}.change-item{border-top:1px solid #f3e9d1;padding:9px 0}.change-item-top{display:flex;justify-content:space-between;align-items:center}.change-item-top b{font-size:12px}.change-reason,.change-note{font-size:12px;color:#677386;margin-top:5px}.change-value{margin-top:6px;padding:7px 9px;border-radius:7px;background:var(--surface);color:#303b4c}.change-value small{font-size:12px;color:#8792a3}.change-value p{margin:3px 0 0;font-size:12px;white-space:pre-wrap}.change-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:8px}.change-pause-note{padding:8px 10px;border-radius:7px;background:#fff4df;color:#9b6208;font-size:12px;margin-bottom:10px}
</style>

<style scoped>.modal.task-reference-modal{width:calc(100vw - 80px);max-width:1800px;height:calc(100vh - 60px);max-height:none}.task-reference-modal .modal-body{overflow:auto;flex:1}.stage-more{border:1px solid var(--line);padding:12px;margin-bottom:18px}.stage-more summary{cursor:pointer;color:var(--brand)}</style>

<style scoped>
.reference-board{--board-blue:#168bfa;padding:0;background:var(--surface);height:calc(100vh - 94px);display:flex;flex-direction:column;min-height:600px}.reference-board>.page-head{padding:10px 14px;margin:0;border-bottom:1px solid var(--line)}.reference-board>.page-head h2{font-size:15px}.reference-board>.page-head .sub{font-size:11px}.reference-board .pattern-filters{display:flex;flex-wrap:wrap;gap:8px 18px;padding:12px 14px;margin:0;border:0;border-radius:0}.reference-board .pattern-filters label{display:flex;align-items:center;gap:8px;font-size:12px}.reference-board .pattern-filters .input{width:180px;height:29px;font-size:12px;min-height:0}.reference-board>.toolbar{padding:8px 14px;margin:0!important;background:var(--surface-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.reference-board>.toolbar>.input{height:30px;min-height:0;font-size:12px}.reference-board .flow-bar{display:none}.reference-board .pboard{flex:1;min-height:0;padding:5px;gap:10px;border-radius:0;align-items:stretch;overflow-x:auto}.reference-board .pcol{width:270px;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:0;display:flex;flex-direction:column;min-height:0}.reference-board .pcol-head{font-size:14px;justify-content:flex-start;gap:2px;padding:8px 6px;border-bottom:1px solid var(--line);height:33px}.reference-board .pcount{background:none;padding:0;color:inherit}.reference-board .pcount:before{content:'('}.reference-board .pcount:after{content:')'}.reference-board .pcol-search{height:27px;min-height:0;font-size:11px;width:calc(100% - 12px);margin:5px 6px}.reference-board .pcol-body{flex:1;min-height:0;max-height:none;padding:6px;gap:10px;overflow-y:auto}.reference-board .pcard{padding:0;border-radius:0;border:1px solid var(--line);box-shadow:none;overflow:hidden;flex-shrink:0}.reference-board .pcard-top{padding:6px;background:var(--surface-2);border-bottom:1px solid var(--line);margin:0;font-size:12px}.reference-board .pattern-card-image{float:left;width:67px;height:96px;margin:8px;object-fit:contain;cursor:zoom-in}.reference-board .pline{font-size:11px;line-height:18px;margin:0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.reference-board .pcard-top+.pline,.reference-board .pcard-top+img+.pline{margin-top:8px}.reference-board .pmeta{clear:both;font-size:11px;color:var(--success,#55ac28);padding:9px 6px;display:flex;flex-wrap:wrap;gap:6px}.reference-board .pacts{clear:both;background:var(--surface-2);padding:9px 6px;display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin:0}.reference-board .pacts .link-btn{font-size:12px;color:var(--board-blue)}.reference-board .pattern-time{font-size:10px;color:var(--board-blue);width:100%}.reference-board .pempty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:220px;flex:1;color:var(--ink-mute)}.empty-box{font-size:80px;line-height:1;color:var(--line)}
</style>
<style scoped>.task-edit-icon{border:1px solid var(--line);background:var(--surface);color:#168bfa;cursor:pointer;padding:1px 4px}.task-urgency{padding:3px 8px;display:inline-block;margin:5px 0;border-radius:3px}</style>

<style scoped>.pattern-stage-tabs{display:flex;gap:8px;padding:12px 14px;overflow-x:auto;border-bottom:1px solid var(--line);flex-shrink:0}.pattern-stage-tabs button{padding:10px 18px;border:1px solid var(--line);background:var(--surface);color:var(--ink);white-space:nowrap;border-radius:3px;font-size:12px;cursor:pointer}.pattern-stage-tabs button.active{background:var(--brand);color:white;border-color:var(--brand)}.reference-board .pboard{display:block;overflow-y:auto;overflow-x:hidden;padding:12px}.reference-board .pcol{width:100%;border:0;margin-bottom:18px;display:block}.reference-board .pcol-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;overflow:visible;padding:8px 0}.reference-board .pcard{min-width:0;align-self:start}.reference-board .pcol-search{width:260px}.reference-board .pcol-head{padding:8px 0}.reference-board .pempty{grid-column:1/-1;min-height:180px}</style>
