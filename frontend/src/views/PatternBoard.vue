<template>
  <div>
    <div class="page-head">
      <div>
        <h2>打版流程</h2>
        <div class="sub">面辅料确认 → 制版 → 工艺明细 → 车板做样衣 → 业务确认样 → 工序审核·工价核价；走完自动归档样衣</div>
      </div>
      <div style="display: flex; gap: 10px">
        <button class="btn btn-ghost" @click="load">刷新</button>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="搜索 款号 / 订单号 / 客户" style="width: 260px" @keyup.enter="load" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <div class="seg">
        <button :class="{ on: show === 'running' }" @click="show = 'running'">进行中 {{ runningCount }}</button>
        <button :class="{ on: show === 'all' }" @click="show = 'all'">全部 {{ flows.length }}</button>
        <button :class="{ on: show === 'done' }" @click="show = 'done'">已完成 {{ doneCount }}</button>
      </div>
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

    <!-- 看板 -->
    <div class="pboard">
      <div v-for="s in stages" :key="s.key" class="pcol">
        <div class="pcol-head">
          <span>{{ s.label }}</span>
          <span class="pcount">{{ colCards(s.key).length }}</span>
        </div>
        <div class="pcol-body">
          <div v-for="f in colCards(s.key)" :key="f.id" class="pcard" @click="openStage(f, s.key)">
            <div class="pcard-top">
              <strong class="pstyle" :title="f.customer_style_no || f.product_name">{{ f.customer_style_no || f.product_name }}</strong>
              <span class="tag" :class="stageTag(f.stage_map[s.key])">{{ stageStatusLabel(f.stage_map[s.key]) }}</span>
            </div>
            <div class="pline">版号：{{ f.version }} · {{ f.product_name }}</div>
            <div class="pline">打板尺码：{{ f.stage_map[s.key] && f.stage_map[s.key].pattern_size || f.order_no || '-' }}</div>
            <div class="pline">客户：{{ f.customer_name || '-' }}</div>
            <div class="pline">创建：{{ $fmtDate(f.started_at) }}</div>
            <div class="pline muted" v-if="f.stage_map[s.key] && f.stage_map[s.key].remark">备注：{{ f.stage_map[s.key].remark }}</div>
            <div class="pmeta">
              <span>作业 {{ f.stage_map[s.key] && f.stage_map[s.key].work_hours || 0 }}h</span>
              <span v-if="f.stage_map[s.key] && f.stage_map[s.key].due_date">预计 {{ f.stage_map[s.key].due_date }}</span>
              <span v-if="f.stage_map[s.key] && f.stage_map[s.key].actual_hours">实际 {{ f.stage_map[s.key].actual_hours }}h</span>
            </div>
            <div class="pacts">
              <button class="link-btn" @click.stop="openStage(f, s.key)">详情 / 填写</button>
            </div>
          </div>
          <div v-if="!colCards(s.key).length" class="pempty">—</div>
        </div>
      </div>

      <div class="pcol">
        <div class="pcol-head"><span>已完成 · 已归档样衣</span><span class="pcount">{{ doneFlows.length }}</span></div>
        <div class="pcol-body">
          <div v-for="f in doneFlows" :key="f.id" class="pcard done" @click="openStage(f, 'audit')">
            <div class="pcard-top">
              <strong class="pstyle">{{ f.customer_style_no || f.product_name }}</strong>
              <span class="tag green">已完成</span>
            </div>
            <div class="pline">订单：{{ f.order_no || '-' }}</div>
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
    <div v-if="cur" class="modal-mask" @click.self="closeStage">
      <div class="modal xwide pb-modal">
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

          <div class="form-grid">
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
                  <button v-if="canEdit" class="img-del" type="button" @click="removeStageImage(i)">删除</button>
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
          <template v-if="cur.stage === 'material'">
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

            <div class="mat-head">
              <h4>
                物料清单
                <span class="hint">点「添加面料 / 添加辅料」从档案里挑；用量、损耗、单价、使用部位、成份在本阶段填</span>
              </h4>
              <div v-if="canEdit && cur.flow.status !== 'done'" style="display: flex; gap: 8px">
                <button class="btn btn-primary btn-sm" @click="openPicker('fabric')">＋ 添加面料</button>
                <button class="btn btn-ghost btn-sm" @click="openPicker('accessory')">＋ 添加辅料</button>
              </div>
            </div>
            <div class="mat-scroll">
              <table class="data mat-tbl">
                <thead>
                  <tr>
                    <th style="width: 56px">类型</th>
                    <th style="min-width: 220px">物料名称 / 规格</th>
                    <th style="width: 100px">款色</th>
                    <th style="width: 180px">色号</th>
                    <th style="min-width: 130px">供应商</th>
                    <th style="min-width: 140px">规格信息</th>
                    <th style="width: 130px">成份 <span style="font-weight:400">可改</span></th>
                    <th style="width: 52px">单位</th>
                    <th style="width: 90px">使用部位</th>
                    <th style="width: 78px">单件用量</th>
                    <th style="width: 64px">损耗%</th>
                    <th style="width: 64px">空差%</th>
                    <th style="width: 74px">单价</th>
                    <th style="width: 76px">单件金额</th>
                    <th style="width: 80px">含损耗用量</th>
                    <th style="width: 100px">备注</th>
                    <th style="width: 66px">物料图</th>
                    <th style="width: 66px">色卡图</th>
                    <th v-if="canEdit" style="width: 42px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(m, i) in materials" :key="i" :class="{ 'from-arc': !!m.material_id }">
                    <td><span class="tag" :class="m.mat_type === 'fabric' ? 'purple' : 'blue'">{{ m.mat_type === 'fabric' ? '面料' : '辅料' }}</span></td>
                    <td>
                      <div v-if="m.material_id" class="locked" :title="m.material_name">
                        <span class="lock">🔒</span>{{ m.material_name }}
                        <div v-if="m.fabric_param" class="sub">{{ m.fabric_param }}</div>
                      </div>
                      <input v-else v-model="m.material_name" :disabled="!canEdit" class="input mini" />
                    </td>
                    <td><input v-model="m.colorway" :disabled="!canEdit" class="input mini" /></td>
                    <td><input v-model="m.color_no" :disabled="!canEdit" class="input mini" placeholder="可自填" /></td>
                    <td>
                      <div v-if="m.material_id" class="locked">
                        {{ m.supplier || '-' }}
                        <div v-if="m.supplier_info" class="sub" :title="m.supplier_info">{{ m.supplier_info }}</div>
                      </div>
                      <input v-else v-model="m.supplier" :disabled="!canEdit" class="input mini" />
                    </td>
                    <td><div v-if="m.material_id" class="locked">{{ m.spec_info || '-' }}</div>
                        <input v-else v-model="m.spec_info" :disabled="!canEdit" class="input mini" /></td>
                    <td>
                      <!-- 成份允许本单覆盖：水洗标 / 烫画标按客户指定填 -->
                      <input v-model="m.composition" :disabled="!canEdit" class="input mini" placeholder="按客户指定" />
                    </td>
                    <td><div v-if="m.material_id" class="locked center">{{ m.unit || '-' }}</div>
                        <input v-else v-model="m.unit" :disabled="!canEdit" class="input mini" /></td>
                    <td><input v-model="m.use_part" :disabled="!canEdit" class="input mini" placeholder="整件/门襟" /></td>
                    <td><input v-model.number="m.one_use" :disabled="!canEdit" type="number" step="0.01" class="input mini" /></td>
                    <td><input v-model.number="m.loss_rate" :disabled="!canEdit" type="number" step="0.1" class="input mini" /></td>
                    <td><input v-model.number="m.air_gap" :disabled="!canEdit" type="number" step="0.1" class="input mini" /></td>
                    <td><input v-model.number="m.unit_price" :disabled="!canEdit" type="number" step="0.01" class="input mini" /></td>
                    <td class="num">{{ money((m.one_use || 0) * (m.unit_price || 0)) }}</td>
                    <td class="num">{{ money((m.one_use || 0) * (1 + (m.loss_rate || 0) / 100)) }}</td>
                    <td><input v-model="m.remark" :disabled="!canEdit" class="input mini" /></td>
                    <td><ImageUpload v-model="m.image_url" size="xs" :disabled="!canEdit" /></td>
                    <td><ImageUpload v-model="m.color_card_url" size="xs" :disabled="!canEdit" /></td>
                    <td v-if="canEdit"><button class="link-btn danger" @click="delMat(i)">删</button></td>
                  </tr>
                  <tr v-if="!materials.length">
                    <td :colspan="canEdit ? 19 : 18" class="empty-cell">
                      还没有物料。点右上角「＋ 添加面料 / ＋ 添加辅料」从面辅料档案挑；档案里没有的先到「档案 → 面辅料档案」建档
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="mat-sum">
              共 {{ materials.length }} 行 · 单件物料成本合计 <strong>{{ money(matTotal) }}</strong> 元
              <span class="hint" style="margin-left: 8px">🔒 = 档案资料，本阶段只读</span>
            </div>
          </template>

          <!-- 工艺/工序明细：车缝工序 + 后整工序两张表 -->
          <template v-if="cur.stage === 'craft'">
            <div class="op" v-for="grp in opGroups" :key="grp.key">
              <div class="op-head">
                <strong>{{ grp.label }}</strong>
                <span class="op-quick">
                  常用工序：
                  <button
                    v-for="t in craftTypes"
                    :key="t.id"
                    type="button"
                    class="op-tag"
                    :disabled="!canEdit"
                    :title="'点一下添加「' + t.name + '」'"
                    @click="addOpRow(grp.key, t)"
                  >{{ t.name }}</button>
                  <span v-if="!craftTypes.length" class="op-none">（工序类别档案里还没有工序，先去「档案 → 工序类别」建）</span>
                </span>
              </div>

              <div class="op-bar">
                <label>工价倍数</label>
                <input class="input op-ratio" type="number" step="0.1" :value="grpRatio(grp.key)"
                       :disabled="!canEdit" @input="setGrpRatio(grp.key, $event.target.value)" />
                <span class="op-tipnum">改这里会同步到本组所有行</span>
                <div style="flex: 1"></div>
                <button class="btn btn-sm op-del" type="button" :disabled="!canEdit" @click="delCheckedOps(grp.key)">删除工序</button>
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
                      <td><button class="link-btn danger" type="button" :disabled="!canEdit" @click="delOpRow(grp.key, i)">删</button></td>
                    </tr>
                    <tr v-if="!form.data[grp.key] || !form.data[grp.key].length">
                      <td colspan="11" class="empty-cell">暂无数据，点上面的常用工序，或「＋ 添加一行数据」</td>
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
          <div v-if="!canEdit && cur.flow.status !== 'done'" class="tip-warn">
            你的角色（{{ roleLabel }}）在这个阶段没有填写权限，当前仅可查看。
          </div>
          <div v-if="cur.flow.status === 'done'" class="tip-warn">
            该打版流程已完成，样衣已归档锁定。如需修改，请到「样衣管理」提交更改需求。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeStage">关闭</button>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import MaterialPicker from '../components/MaterialPicker.vue';
import ImageUpload from '../components/ImageUpload.vue';
import { auth, ROLE_LABELS } from '../store/auth';

const STAGE_FIELDS = {
  // 面料 / 辅料补充说明不在这里渲染：跟着平铺勾选区走，见模板里 material 段
  material: [],
  pattern: [
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

const stages = ref([]);
const flows = ref([]);
const q = ref('');
const show = ref('running');
const cur = ref(null);
const form = ref(blankForm());
const busy = ref(false);
const dirty = ref(false);
let formSilent = false;
// 表单任何改动都记为「未保存」，用于切换阶段 / 关闭时提醒
watch(form, () => { if (!formSilent) dirty.value = true; }, { deep: true });
const materials = ref([]);
const pickerOpen = ref(false);
const pickerType = ref('fabric');
const gpOpen = ref(false);
const craftTypes = ref([]);
const opGroups = [
  { key: 'sewing', label: '车缝工序', cat: '车缝' },
  { key: 'finish', label: '后整工序', cat: '后整' }
];
const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
const matTotal = computed(() => materials.value.reduce((s, m) => s + (Number(m.one_use) || 0) * (Number(m.unit_price) || 0), 0));

const router = useRouter();
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
 * 只保留关键词搜索的过滤。
 */
const doneFlows = computed(() => {
  let list = flows.value.filter((f) => f.status === 'done');
  const kw = q.value.trim().toLowerCase();
  if (kw) {
    list = list.filter((f) =>
      [f.customer_style_no, f.product_name, f.order_no, f.customer_name].some((v) => (v || '').toLowerCase().includes(kw))
    );
  }
  return list;
});

const filtered = computed(() => {
  let list = flows.value;
  if (show.value === 'running') list = list.filter((f) => f.status === 'running');
  else if (show.value === 'done') list = list.filter((f) => f.status === 'done');
  if (q.value.trim()) {
    const kw = q.value.trim().toLowerCase();
    list = list.filter((f) =>
      [f.customer_style_no, f.product_name, f.order_no, f.customer_name].some((v) => (v || '').toLowerCase().includes(kw))
    );
  }
  return list;
});

const stageFields = computed(() => (cur.value ? STAGE_FIELDS[cur.value.stage] || [] : []));
const canEdit = computed(() => !!(cur.value && cur.value.flow.status !== 'done' && can('pattern.' + cur.value.stage)));
const canFinish = computed(() => {
  if (!cur.value) return false;
  const f = cur.value.flow;
  if (f.status === 'done') return false;
  const allDone = stages.value.every((s) => f.stage_map[s.key].status === 'done');
  return allDone && can('pattern.audit');
});

function blankForm() {
  return { owner: '', pattern_size: '', label_name: '', due_date: '', work_hours: 0, actual_hours: 0, price: 0, remark: '', data: {} };
}

const stageLabel = (k) => (stages.value.find((s) => s.key === k) || {}).label || k;
const stageTag = (d) => (d && d.status === 'done' ? 'green' : d && d.status === 'doing' ? 'orange' : 'gray');
const stageStatusLabel = (d) => (d && d.status === 'done' ? '已完成' : d && d.status === 'doing' ? '进行中' : '待开始');

const runningFlows = computed(() => filtered.value.filter((f) => f.status === 'running'));
/** 每列只放「当前阶段正好停在这一步」的流程，避免同一单子重复出现在后续列 */
function colCards(stageKey) {
  return runningFlows.value.filter((f) => f.current_stage === stageKey);
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
  const gap = Number(String(a.air_gap || '').replace(/[^\d.]/g, ''));
  return {
    material_id: a.id,
    mat_type: a.type,
    colorway: a.color || '',
    material_name: a.name,
    color_no: a.color_no || '',
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
  await api.savePatternMaterials(cur.value.flow.id, materials.value);
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
    category: tpl && tpl.category ? (CAT_LABEL[tpl.category] || tpl.category) : grpCat(k),
    name: tpl ? tpl.name : '',
    price: tpl ? Number(tpl.default_price) || 0 : 0,
    ratio: grpRatio(k),
    owner: '',
    remark: '',
    open_price: 0
  });
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
async function loadCraftTypes() {
  try { craftTypes.value = (await api.craftTypes({ status: 'active' })) || []; }
  catch (e) { craftTypes.value = []; }
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

onMounted(() => { load(); loadCraftTypes(); });
</script>

<style scoped>
.flow-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.flow-step {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px 6px 6px;
  border: 1px solid #e6ebf3; border-radius: 22px; font-size: 12.5px; color: #5b6474; background: #fff;
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
  width: 20px; height: 20px; border-radius: 50%; background: #eef2f7; color: #8a94a6;
  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
}
.flow-step .lbl { font-weight: 600; color: #33415a; }
.flow-step .cnt { background: #eef2f7; color: #5b6474; border-radius: 9px; padding: 0 6px; font-size: 11px; }
.flow-step.end { border-style: dashed; }

.pboard { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 10px; align-items: flex-start; }
.pcol { width: 232px; flex: none; background: #f6f8fc; border-radius: 12px; padding: 8px; }
.pcol-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12.5px; font-weight: 700; color: #16233b; padding: 4px 6px 8px;
}
.pcount { background: #fff; border: 1px solid #e6ebf3; border-radius: 9px; padding: 0 6px; font-size: 11px; color: #5b6474; }
.pcol-body { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; }

.pcard { background: #fff; border: 1px solid #e6ebf3; border-radius: 10px; padding: 9px 10px; cursor: pointer; }
.pcard:hover { border-color: #b9ceff; box-shadow: 0 2px 10px rgba(43, 109, 229, 0.08); }
.pcard.done { cursor: default; }
.pcard-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 5px; }
.pstyle { font-size: 12.5px; color: #16233b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pline { font-size: 11.5px; color: #5b6474; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pline.muted { color: #8a94a6; }
.pmeta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; font-size: 11px; color: #8a94a6; }
.pacts { margin-top: 6px; border-top: 1px dashed #eef2f7; padding-top: 5px; }
.pempty { text-align: center; color: #c2ccdb; font-size: 12px; padding: 14px 0; }

.op { border: 1px solid #e6ebf3; border-radius: 12px; background: #fff; margin: 12px 0; padding: 10px 12px; }
.op-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.op-head strong { flex: none; font-size: 13px; color: #16233b; padding-top: 3px; }
.op-quick { flex: 1; font-size: 11.5px; color: #8a94a6; line-height: 2; }
.op-tag {
  border: 1px solid #e2e8f2; background: #f7f9fc; border-radius: 4px; padding: 1px 7px;
  font-size: 11.5px; color: #33415a; cursor: pointer; margin: 0 2px 2px 0;
}
.op-tag:hover { border-color: #2b6de5; color: #2b6de5; background: #eef4ff; }
.op-tag:disabled { cursor: default; opacity: 0.55; }
.op-none { font-size: 11.5px; color: #b6bfcd; }
.op-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.op-bar label { font-size: 12.5px; color: #5b6474; }
.op-ratio { width: 92px; }
.op-tipnum { font-size: 11px; color: #a9b4c5; }
.op-del { background: #fdecee; color: #d92d45; border: 1px solid #f8d3d8; }
.op-del:hover { background: #fbdde1; }
.op-scroll { overflow-x: auto; border: 1px solid #eef2f7; border-radius: 8px; }
.op-tbl { border: none; min-width: 1020px; }
.op-tbl th, .op-tbl td { padding: 4px 6px; font-size: 12px; white-space: nowrap; }
.op-tbl .input.mini { width: 100%; padding: 3px 6px; font-size: 12px; }
.op-tbl td.center { text-align: center; }
.op-tbl td.num { text-align: right; font-weight: 600; }
.op-tbl .empty-cell { text-align: center; color: #8a94a6; padding: 10px; }
.op-foot { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.op-add {
  border: 1px dashed #cdd7e5; background: #fbfcfe; border-radius: 8px; padding: 6px 14px;
  font-size: 12.5px; color: #2b6de5; cursor: pointer; width: 100%;
}
.op-add:hover { border-color: #2b6de5; background: #f3f7ff; }
.op-sum { flex: none; font-size: 12px; color: #5b6474; }
.op-sum strong { color: #16233b; }
.img-hint { font-weight: 400; font-size: 11.5px; color: #8a94a6; margin-left: 8px; }
.imgs { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
.img-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.img-cell .img-del { border: none; background: none; padding: 0; font-size: 11px; color: #e5484d; cursor: pointer; }
.img-add {
  width: 96px; height: 96px; border: 1px dashed #d5dde9; border-radius: 10px; background: #fbfcfe;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  color: #8a94a6; cursor: pointer; font-size: 18px;
}
.img-add small { font-size: 11px; }
.img-add:hover { border-color: #2b6de5; color: #2b6de5; }
.gp { border: 1px solid #e6ebf3; border-radius: 12px; background: #fafbfd; margin-bottom: 14px; }
.gp-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid #eef2f7; }
.gp-head strong { font-size: 13px; color: #16233b; }
.gp-sub { flex: 1; font-size: 11.5px; color: #8a94a6; }
.gp-body { padding: 10px 14px 12px; max-height: 34vh; overflow-y: auto; }
.gp-block-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.gp-block-head > span:first-child { font-size: 12.5px; font-weight: 700; color: #16233b; }
.gp-meta { font-size: 11.5px; color: #2b6de5; }
.gp-scroll { overflow-x: auto; border: 1px solid #eef2f7; border-radius: 8px; background: #fff; max-height: 168px; overflow-y: auto; }
.gp-tbl { border: none; min-width: 860px; }
.gp-tbl th, .gp-tbl td { padding: 4px 8px; font-size: 11.5px; white-space: nowrap; }
.gp-tbl td.num { text-align: right; font-weight: 600; }
.gp-tbl td.nm { max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
.gp-tbl .empty-cell { text-align: center; color: #8a94a6; }
.gp-stages { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; margin-top: 10px; }
.gp-stage { background: #fff; border: 1px solid #eef2f7; border-radius: 9px; padding: 8px 10px; }
.gp-stage.on { border-color: #2b6de5; box-shadow: 0 0 0 2px rgba(43, 109, 229, 0.08); }
.gp-stage.blank { opacity: 0.7; }
.gp-stage-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.gp-stage-head strong { font-size: 12px; color: #16233b; }
.gp-meta-line {
  font-size: 11px; color: #8a94a6; margin: -2px 0 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gp-kv { display: flex; gap: 8px; font-size: 11.5px; line-height: 1.6; }
.gp-kv span { flex: none; width: 88px; color: #8a94a6; }
.gp-kv b { color: #33415a; font-weight: 500; word-break: break-all; }
.gp-kv.full { flex-direction: column; gap: 1px; }
.gp-kv.full span { width: auto; }
.gp-kv.full b { white-space: pre-wrap; }
.gp-none { font-size: 11.5px; color: #b6bfcd; }
.stage-strip { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.stage-strip .ss {
  font-size: 11.5px; color: #8a94a6; background: #f6f8fc; border-radius: 12px; padding: 3px 9px;
}
.stage-strip .ss.done { background: #e6f7ec; color: #16a34a; }
.stage-strip .ss.jump { cursor: pointer; }
.stage-strip .ss.jump:hover { border-color: #2b6de5; color: #2b6de5; }
.ss.on { background: #e8f0ff; color: #2563eb; font-weight: 700; }
.modal.xwide.pb-modal { width: 1460px; max-width: 97vw; }
.pb-modal .modal-body { max-height: 82vh; }
.mat-notes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin: 14px 0 4px; }
@media (max-width: 1100px) { .mat-notes { grid-template-columns: 1fr; } }
.note-row { display: flex; align-items: center; gap: 10px; margin: 0; }
.note-row label { flex: none; width: 142px; white-space: nowrap; font-size: 12.5px; color: #5b6474; }
.note-row .input { flex: 1; }
.mat-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 16px 0 8px; flex-wrap: wrap; }
.mat-head h4 { margin: 0; font-size: 13px; color: #16233b; }
.mat-head .hint { font-weight: 400; font-size: 11.5px; color: #8a94a6; margin-left: 6px; }
.mat-scroll { overflow-x: auto; border: 1px solid #eef2f7; border-radius: 8px; }
.mat-tbl { border: none; min-width: 1700px; }
.mat-tbl th, .mat-tbl td { white-space: nowrap; padding: 5px 6px; font-size: 12px; vertical-align: middle; }
.mat-tbl .input.mini { width: 100%; padding: 4px 6px; font-size: 12px; }
.mat-tbl td.num { text-align: right; font-weight: 600; color: #16233b; }
.mat-tbl .locked { font-size: 12px; color: #33415a; line-height: 1.35; max-width: 200px; }
.mat-tbl .locked.center { text-align: center; }
.mat-tbl .locked .sub { font-size: 11px; color: #8a94a6; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-tbl .lock { font-size: 9px; margin-right: 3px; opacity: 0.5; }
.mat-tbl tr.from-arc td { background: #fbfcfe; }
.mat-sum { margin-top: 6px; font-size: 12.5px; color: #5b6474; }
.tip-warn {
  margin-top: 10px; background: #fff8e6; border: 1px solid #ffe0a3; color: #b26a00;
  border-radius: 8px; padding: 8px 10px; font-size: 12px;
}
</style>
