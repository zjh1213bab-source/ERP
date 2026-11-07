<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>首件确认与工位工艺</h2>
        <p class="sub">
          大货前按冻结版做首件：测尺寸、验关键工艺、记实测与证据，质检复核放行才允许批量投产。
          首件发现资料不全或不可制造，退回销售 / 总部技术，工厂不自行改版。
        </p>
      </div>
      <div class="head-ops"><button class="btn btn-ghost" @click="loadBoard">刷新</button></div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>在产订单</span>
        <strong>{{ stat.orders || 0 }}</strong>
        <small>未放行 {{ stat.need_fa || 0 }} 单</small>
      </div>
      <div class="stat">
        <span>未做首件</span>
        <strong :class="stat.no_fa ? 'amt-orange' : ''">{{ stat.no_fa || 0 }}</strong>
        <small>不能投产</small>
      </div>
      <div class="stat">
        <span>待复核</span>
        <strong class="amt-blue">{{ stat.submitted || 0 }}</strong>
        <small>草稿 {{ stat.draft || 0 }} 张</small>
      </div>
      <div class="stat">
        <span>已放行</span>
        <strong class="amt-green">{{ stat.passed || 0 }}</strong>
        <small>放行合计 {{ stat.released_qty || 0 }} 件</small>
      </div>
      <div class="stat">
        <span>退回 / 失效</span>
        <strong :class="stat.rejected || stat.stale ? 'amt-red' : ''">{{ stat.rejected || 0 }}</strong>
        <small :class="stat.stale ? 'amt-red' : ''">改版失效 {{ stat.stale || 0 }}</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="订单号 / 款号 / 首件单号" style="width: 230px" @keyup.enter="loadBoard" />
      <select class="select" v-model="status" style="width: 150px" @change="loadBoard">
        <option value="">全部</option>
        <option value="none">还没做首件</option>
        <option value="draft">草稿</option>
        <option value="submitted">待复核</option>
        <option value="passed">已放行</option>
        <option value="conditional">限定放行</option>
        <option value="rejected">不合格退回</option>
      </select>
      <button class="btn btn-ghost" @click="loadBoard">查询</button>
      <div style="flex: 1"></div>
      <span class="muted" style="font-size: 12px">缝制及之后工序报工，系统会校验首件是否已放行</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 150px">首件单</th>
            <th style="width: 144px">订单号</th>
            <th style="min-width: 170px">款号</th>
            <th style="width: 78px">冻结版</th>
            <th style="width: 96px">工位工艺</th>
            <th style="width: 76px">本批</th>
            <th style="width: 84px">放行量</th>
            <th style="width: 104px">状态</th>
            <th style="width: 92px">批量投产</th>
            <th style="width: 78px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.order_id" :class="{ 'row-red': !r.released, 'row-warn': r.fa && r.fa.stale }">
            <td>
              <span v-if="r.fa">{{ r.fa.fa_no }}</span>
              <span v-else class="muted">— 未登记 —</span>
            </td>
            <td>{{ r.order_no }}</td>
            <td class="sub-cell">{{ r.style_no || '-' }}</td>
            <td class="center">
              <span v-if="r.fa" class="tag" :class="r.fa.stale ? 'red' : 'gray'">{{ r.fa.tech_pack_version || '-' }}</span>
              <span v-else class="tag gray">{{ r.tech_pack_version || '无' }}</span>
            </td>
            <td class="center">
              <span class="tag" :class="r.ws_count ? 'green' : 'orange'">{{ r.ws_count }} 道</span>
            </td>
            <td class="num">{{ r.fa ? r.fa.batch_qty : '-' }}</td>
            <td class="num" :class="r.released ? 'amt-green' : 'muted'">{{ r.fa && r.fa.release_qty ? r.fa.release_qty : '-' }}</td>
            <td>
              <span v-if="r.fa" class="tag" :class="faTag(r.fa)">{{ r.fa.status_label }}</span>
              <span v-else class="tag gray">未登记</span>
            </td>
            <td>
              <span class="tag" :class="r.released ? 'green' : 'red'" :title="r.block_reason || ''">
                {{ r.released ? '可投产' : '已拦截' }}
              </span>
            </td>
            <td class="ops"><button class="link-btn" @click="open(r)">{{ r.fa ? '查看' : '做首件' }}</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="10" class="empty-cell">没有在产订单（订单进入「已分单 / 生产中」后才会出现在这里）</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 详情 -->
    <div v-if="cur" class="modal-mask">
      <div class="modal xwide fa-modal">
        <div class="modal-head">
          <h3>
            {{ cur.fa ? cur.fa.fa_no : '登记首件' }} · {{ cur.order.order_no }}
            <span class="muted" style="font-weight: 400; font-size: 12px">
              {{ cur.order.style_no || '' }}
              <template v-if="cur.fa"> · {{ cur.fa.status_label }} · {{ cur.fa.fa_type === 'simple' ? '简化首件' : '全项首件' }}</template>
            </span>
          </h3>
          <button class="x" @click="close">×</button>
        </div>

        <div class="modal-body">
          <div v-if="cur.order_items?.length>1" class="fa-sec">
            <label>首件检验款式</label>
            <select class="select" :value="cur.selected_item_id" :disabled="busy" @change="open({order_id:cur.order.id,order_item_id:Number($event.target.value)})">
              <option v-for="item in cur.order_items" :key="item.id" :value="item.id">{{ item.style_no || item.product_name }} · {{ item.qty }} 件</option>
            </select>
            <p class="muted">每款分别引用当前冻结版检验；所有款式放行后才允许整单批量报工。</p>
          </div>
          <!-- 未登记：先建单 -->
          <template v-if="!cur.fa">
            <div v-if="!cur.tech_pack" class="fa-warn">
              ⚠ 这单还没有已确认的技术版，不能做首件。首件是按冻结版核验的，请先让总部技术把开发单确认。
            </div>
            <div class="fa-sec">
              <h4>登记首件</h4>
              <div class="form-grid">
                <label>首件类型
                  <select class="select" v-model="newForm.fa_type">
                    <option value="full">全项首件（新单 / 改版）</option>
                    <option value="simple">成熟返单简化首件</option>
                  </select>
                </label>
                <label>本批件数
                  <input class="input" type="number" v-model.number="newForm.batch_qty" />
                </label>
                <label>首件尺码
                  <input class="input" v-model="newForm.sample_size" placeholder="如 M" />
                </label>
                <label>首件取自扎号
                  <input class="input" v-model="newForm.sample_bundle_no" placeholder="如 B003" />
                </label>
                <label class="span2">检查范围
                  <input class="input" v-model="newForm.scope" placeholder="如 领口 / 尺寸 / 缝线" />
                </label>
              </div>
              <div class="muted" style="font-size: 12px; margin-top: 6px">
                冻结版：{{ cur.tech_pack ? cur.tech_pack.version + ' · ' + (cur.tech_pack.product_name || '') : '无' }}
                ；工位工艺 {{ cur.workstations.length }} 道
              </div>
            </div>
          </template>

          <template v-else>
            <!-- 拦截 / 失效提示 -->
            <div v-if="!cur.gate.released" class="fa-warn">
              ⚠ 批量投产被拦截：{{ cur.gate.reason }}
            </div>
            <div v-if="cur.fa.stale" class="fa-warn">
              ⚠ 首件已失效：{{ cur.fa.stale_reason }}
              <button class="link-btn" style="margin-left: 8px" @click="refreshVersion">按新版重做</button>
            </div>
            <div v-if="cur.fa.status === 'rejected' && cur.fa.return_reason" class="fa-warn">
              ↩ 已{{ cur.fa.return_to_label }}：{{ cur.fa.return_reason }}
            </div>

            <!-- 基本信息 -->
            <div class="fa-sec">
              <div class="fa-sec-head">
                <h4>首件信息</h4>
                <span class="muted" style="font-size: 12px">
                  引用冻结版 {{ cur.fa.tech_pack_version }}（技术版 #{{ cur.fa.tech_pack_id }}）
                  <template v-if="cur.fa.current_tech_pack"> · 当前冻结版 {{ cur.fa.current_tech_pack.version }}</template>
                </span>
              </div>
              <div class="fa-sum">
                <div><span>检查项</span><b>{{ cur.fa.sum.total }}</b></div>
                <div><span>尺寸</span><b>{{ cur.fa.sum.size }}</b></div>
                <div><span>关键工艺</span><b>{{ cur.fa.sum.craft }}</b></div>
                <div><span>已测</span><b>{{ cur.fa.sum.done }}/{{ cur.fa.sum.total }}</b></div>
                <div><span>合格</span><b class="amt-green">{{ cur.fa.sum.ok }}</b></div>
                <div><span>不合格</span><b :class="cur.fa.sum.ng ? 'amt-red' : ''">{{ cur.fa.sum.ng }}</b></div>
                <div><span>关键项 NG</span><b :class="cur.fa.sum.ng_critical ? 'amt-red' : ''">{{ cur.fa.sum.ng_critical }}</b></div>
                <div><span>放行量</span><b class="amt-green">{{ cur.fa.release_qty || 0 }}</b></div>
              </div>

              <div class="form-grid" style="margin-top: 10px">
                <label>首件类型
                  <select class="select" v-model="edit.fa_type" :disabled="locked">
                    <option value="full">全项首件</option>
                    <option value="simple">成熟返单简化首件</option>
                  </select>
                </label>
                <label>本批件数
                  <input class="input" type="number" v-model.number="edit.batch_qty" :disabled="locked" />
                </label>
                <label>首件尺码
                  <input class="input" v-model="edit.sample_size" :disabled="locked" placeholder="如 M" />
                </label>
                <label>首件取自扎号
                  <input class="input" v-model="edit.sample_bundle_no" :disabled="locked" />
                </label>
                <label class="span2">检查范围
                  <input class="input" v-model="edit.scope" :disabled="locked" placeholder="如 领口 / 尺寸 / 缝线" />
                </label>
                <label class="span2">备注 / 证据说明
                  <input class="input" v-model="edit.remark" :disabled="locked" />
                </label>
              </div>
              <div class="ev-row">
                <span class="muted" style="font-size: 12px">首件实物证据</span>
                <ImageUpload v-for="(u, i) in evidence" :key="i" :model-value="u" size="sm" :disabled="locked"
                  @update:model-value="(v) => setEvidence(i, v)" />
              </div>
            </div>

            <!-- 工位工艺 -->
            <div class="fa-sec">
              <div class="fa-sec-head">
                <h4>工位工艺（作业指导）</h4>
                <div class="fa-ops">
                  <button v-if="!cur.workstations.length" class="btn btn-ghost btn-sm" :disabled="busy" @click="genWs">
                    从工序生成
                  </button>
                  <button v-if="cur.workstations.length" class="btn btn-ghost btn-sm" :disabled="busy || locked" @click="saveWs">
                    保存工位工艺
                  </button>
                </div>
              </div>
              <div class="table-wrap">
                <table class="data ws-tbl">
                  <thead>
                    <tr>
                      <th style="width: 54px">序</th>
                      <th style="width: 96px">工序</th>
                      <th style="width: 132px">工位</th>
                      <th style="min-width: 250px">工艺要求</th>
                      <th style="width: 150px">设备 / 辅具</th>
                      <th style="min-width: 170px">关键控制点</th>
                      <th style="width: 72px">工时</th>
                      <th style="width: 60px">关键</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="w in ws" :key="w.id">
                      <td class="center">{{ w.seq }}</td>
                      <td>{{ w.craft_name }}</td>
                      <td><input class="input cell" v-model="w.workstation" :disabled="locked" /></td>
                      <td><textarea class="input cell ta" rows="2" v-model="w.requirement" :disabled="locked"></textarea></td>
                      <td><input class="input cell" v-model="w.machine" :disabled="locked" /></td>
                      <td><textarea class="input cell ta" rows="2" v-model="w.key_point" :disabled="locked"></textarea></td>
                      <td><input class="input cell num" type="number" v-model.number="w.std_time" :disabled="locked" /></td>
                      <td class="center">
                        <input type="checkbox" v-model="w.critical" :value="1" :true-value="1" :false-value="0" :disabled="locked" />
                      </td>
                    </tr>
                    <tr v-if="!cur.workstations.length">
                      <td colspan="8" class="empty-cell">还没有工位工艺卡，点「从工序生成」按 13 道工序自动建卡</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 检查项 -->
            <div class="fa-sec">
              <div class="fa-sec-head">
                <h4>首件检查项</h4>
                <div class="fa-ops">
                  <span class="muted" style="font-size: 12px">首件尺码</span>
                  <input class="input mini" v-model="genForm.size" placeholder="M" />
                  <label class="chk"><input type="checkbox" v-model="genForm.include_all_craft" /> 含非关键工艺</label>
                  <label class="chk"><input type="checkbox" v-model="genForm.replace" /> 覆盖已有项</label>
                  <button class="btn btn-ghost btn-sm" :disabled="busy || locked" @click="genChecks">按技术版生成</button>
                  <button class="btn btn-ghost btn-sm" :disabled="busy || locked" @click="addCheck">＋ 手工加项</button>
                </div>
              </div>
              <div class="table-wrap">
                <table class="data ck-tbl">
                  <thead>
                    <tr>
                      <th style="width: 76px">类别</th>
                      <th style="width: 118px">工位</th>
                      <th style="width: 120px">部位 / 检查项</th>
                      <th style="min-width: 230px">标准 / 要求</th>
                      <th style="width: 70px">公差</th>
                      <th style="width: 116px">实测</th>
                      <th style="width: 92px">结论</th>
                      <th style="width: 54px">关键</th>
                      <th style="width: 44px"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in cur.fa.checks" :key="c.id" :class="{ 'row-ng': c.result === 'ng' }">
                      <td class="center"><span class="tag nowrap" :class="kindTag(c.kind)">{{ c.kind_label }}</span></td>
                      <td class="sub-cell">{{ c.workstation || '-' }}</td>
                      <td>{{ c.part }}</td>
                      <td class="sub-cell wrap">{{ c.spec || '-' }}</td>
                      <td class="center">{{ c.tolerance || '-' }}</td>
                      <td>
                        <input class="input cell" v-model="c.measured" :disabled="locked"
                          :placeholder="c.kind === 'size' ? '实测值' : '实测结论'" @change="saveCheck(c)" />
                      </td>
                      <td>
                        <select class="select cell" v-model="c.result" :disabled="locked" @change="saveCheck(c)">
                          <option :value="null">未测</option>
                          <option value="ok">合格</option>
                          <option value="ng">不合格</option>
                        </select>
                      </td>
                      <td class="center">
                        <span v-if="c.critical" class="tag red" style="font-size: 10px">关键</span>
                        <span v-else class="muted" style="font-size: 11px">—</span>
                      </td>
                      <td>
                        <button v-if="!locked" class="link-btn danger" @click="delCheck(c)">删</button>
                      </td>
                    </tr>
                    <tr v-if="!cur.fa.checks.length">
                      <td colspan="9" class="empty-cell">还没有检查项，点「按技术版生成」按冻结版尺寸表 + 关键工序生成</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 放行 -->
            <div v-if="cur.fa.status === 'submitted'" class="fa-sec release-box">
              <h4>质量复核放行</h4>
              <div class="finish-row">
                <label>放行结论</label>
                <select class="select" v-model="relForm.result" style="width: 150px">
                  <option value="passed">合格，全批放行</option>
                  <option value="conditional">限定放行</option>
                </select>
                <label>放行量</label>
                <input class="input mini" type="number" v-model.number="relForm.release_qty" />
                <span class="muted" style="font-size: 12px">/ 本批 {{ cur.fa.batch_qty }} 件</span>
              </div>
              <div v-if="relForm.result === 'conditional'" class="finish-row" style="margin-top: 8px">
                <label>限定条件 *</label>
                <input class="input" v-model="relForm.limit_note" placeholder="如：仅放行 XS 码 45 件，领口罗纹待客户确认后执行" style="flex: 1" />
              </div>
              <div class="finish-row" style="margin-top: 8px">
                <label>结论说明</label>
                <input class="input" v-model="relForm.conclusion" placeholder="如：首件合格，全批放行" style="flex: 1" />
              </div>
              <div v-if="cur.fa.sum.ng_critical" class="fa-warn" style="margin-top: 8px">
                ⚠ 有 {{ cur.fa.sum.ng_critical }} 项关键项不合格，不能放行，只能退回处理。
              </div>
              <div v-else-if="cur.fa.sum.ng" class="fa-warn warn-amber" style="margin-top: 8px">
                有 {{ cur.fa.sum.ng }} 项非关键项不合格：只能「限定放行」并写明限定条件。
              </div>
            </div>
          </template>
        </div>

        <div class="modal-foot">
          <span class="muted" style="margin-right: auto; font-size: 12px">
            <template v-if="cur.fa && cur.fa.inspector">制作/测量 {{ cur.fa.inspector }} · </template>
            <template v-if="cur.fa && cur.fa.released_by">放行 {{ cur.fa.released_by }} · </template>
            <template v-if="cur.fa && cur.fa.released_at">{{ $fmt(cur.fa.released_at) }}</template>
          </span>
          <button class="btn btn-ghost" @click="close">关闭</button>
          <template v-if="!cur.fa">
            <button class="btn btn-primary" :disabled="busy || !canCreate" @click="create">登记首件</button>
          </template>
          <template v-else>
            <button v-if="!locked" class="btn btn-ghost" :disabled="busy" @click="saveInfo">保存信息</button>
            <button v-if="cur.fa.status === 'rejected'" class="btn btn-ghost" :disabled="busy" @click="reopen">重做</button>
            <button v-if="!locked" class="btn btn-primary" :disabled="busy || !cur.fa.can_submit" @click="submit">
              提交复核
            </button>
            <button v-if="cur.fa.status === 'submitted'" class="btn btn-danger" :disabled="busy" @click="reject">退回</button>
            <button v-if="cur.fa.status === 'submitted'" class="btn btn-primary" :disabled="busy || !cur.fa.can_release" @click="release">
              复核放行
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import ImageUpload from '../components/ImageUpload.vue';

const stat = ref({});
const rows = ref([]);
const q = ref('');
const status = ref('');
const cur = ref(null);
const ws = ref([]);
const busy = ref(false);
const evidence = ref(['', '', '']);

const newForm = ref({ fa_type: 'full', batch_qty: 0, sample_size: '', sample_bundle_no: '', scope: '' });
const edit = ref({});
const genForm = ref({ size: '', include_all_craft: false, replace: false });
const relForm = ref({ result: 'passed', release_qty: 0, limit_note: '', conclusion: '' });

const locked = computed(() => {
  const s = cur.value && cur.value.fa ? cur.value.fa.status : '';
  return s === 'passed' || s === 'conditional' || s === 'submitted';
});
const canCreate = computed(() => !!(cur.value && cur.value.tech_pack));

const faTag = (fa) => {
  if (fa.stale) return 'red';
  return { draft: 'gray', submitted: 'blue', passed: 'green', conditional: 'orange', rejected: 'red' }[fa.status] || 'gray';
};
const kindTag = (k) => ({ size: 'blue', craft: 'purple', look: 'gray' }[k] || 'gray');

async function loadBoard() {
  try {
    const d = await api.faBoard({ q: q.value, status: status.value });
    stat.value = d.stat || {};
    rows.value = d.rows || [];
  } catch (e) { alert(e.message); }
}

async function open(r) {
  try {
    const d = await api.faByOrder(r.order_id,{order_item_id:r.order_item_id});
    cur.value = d;
    ws.value = (d.workstations || []).map((w) => ({ ...w }));
    if (d.fa) {
      edit.value = {
        fa_type: d.fa.fa_type, batch_qty: d.fa.batch_qty, sample_size: d.fa.sample_size || '',
        sample_bundle_no: d.fa.sample_bundle_no || '', scope: d.fa.scope || '', remark: d.fa.remark || ''
      };
      let ev = [];
      try { ev = JSON.parse(d.fa.evidence || '[]'); } catch (e) { ev = []; }
      evidence.value = [ev[0] || '', ev[1] || '', ev[2] || ''];
      genForm.value.size = d.fa.sample_size || '';
      relForm.value = {
        result: d.fa.must_limit ? 'conditional' : 'passed',
        release_qty: d.fa.batch_qty,
        limit_note: d.fa.limit_note || '',
        conclusion: d.fa.conclusion || ''
      };
    } else {
      newForm.value = {
        order_item_id:d.selected_item_id,fa_type: 'full', batch_qty: d.template.batch_qty || 0,
        sample_size: '', sample_bundle_no: '', scope: ''
      };
    }
  } catch (e) { alert(e.message); }
}

async function refresh() {
  if (!cur.value) return;
  const id = cur.value.order.id;
  const d = await api.faByOrder(id,{order_item_id:cur.value.selected_item_id});
  cur.value = d;
  ws.value = (d.workstations || []).map((w) => ({ ...w }));
  await loadBoard();
}

function close() { cur.value = null; }

function setEvidence(i, v) {
  const arr = [...evidence.value];
  arr[i] = v || '';
  evidence.value = arr;
}

async function create() {
  if (!canCreate.value) return alert('这单没有已确认的技术版，不能做首件');
  if (!(newForm.value.batch_qty > 0)) return alert('本批件数必须大于 0');
  busy.value = true;
  try {
    const d = await api.createFa({ order_id: cur.value.order.id, ...newForm.value });
    alert(`已登记 ${d.fa_no}。下一步：点「从工序生成」建工位工艺，再「按技术版生成」检查项`);
    await refresh();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function saveInfo() {
  busy.value = true;
  try {
    await api.saveFa(cur.value.fa.id, { ...edit.value, evidence: evidence.value.filter(Boolean) });
    await refresh();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function genWs() {
  busy.value = true;
  try {
    const r = await api.generateWorkstations(cur.value.order.id);
    await refresh();
    if (r.warnings && r.warnings.length) alert('已生成工位工艺卡：\n' + r.warnings.join('\n'));
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function saveWs() {
  busy.value = true;
  try {
    for (const w of ws.value) {
      await api.saveWorkstation({
        id: w.id, order_id: cur.value.order.id, craft_name: w.craft_name,
        workstation: w.workstation, requirement: w.requirement, machine: w.machine,
        key_point: w.key_point, std_time: w.std_time, critical: w.critical
      });
    }
    await refresh();
    alert('工位工艺已保存');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function genChecks() {
  busy.value = true;
  try {
    const r = await api.generateFaChecks(cur.value.fa.id, { ...genForm.value });
    await refresh();
    if (r.warnings && r.warnings.length) alert('提示：\n' + r.warnings.join('\n'));
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function addCheck() {
  const part = prompt('部位 / 检查项（如 领口罗纹、下摆车线）：');
  if (!part) return;
  const spec = prompt('标准 / 要求：', '') || '';
  const kind = prompt('类别：size 尺寸 / craft 关键工艺 / look 外观', 'size') || 'size';
  busy.value = true;
  try {
    await api.saveFaCheck(cur.value.fa.id, { part: part.trim(), spec, kind, critical: kind === 'size' ? 1 : 0 });
    await refresh();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function saveCheck(c) {
  try {
    await api.saveFaCheck(cur.value.fa.id, { id: c.id, measured: c.measured, result: c.result });
    await refresh();
  } catch (e) { alert(e.message); }
}

async function delCheck(c) {
  if (!confirm(`删除检查项「${c.part}」？`)) return;
  try {
    await api.deleteFaCheck(cur.value.fa.id, c.id);
    await refresh();
  } catch (e) { alert(e.message); }
}

async function submit() {
  busy.value = true;
  try {
    await api.submitFa(cur.value.fa.id);
    await refresh();
    alert('已提交复核，等质量/生产负责人复核放行');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function release() {
  const f = relForm.value;
  if (!(f.release_qty > 0)) return alert('放行量必须大于 0');
  if (f.result === 'conditional' && !String(f.limit_note).trim()) return alert('限定放行必须写明限定条件');
  busy.value = true;
  try {
    await api.releaseFa(cur.value.fa.id, f);
    await refresh();
    alert(`已放行 ${f.release_qty} 件。缝制及之后工序现在可以报工了`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function reject() {
  const to = confirm('退回销售？（点「取消」= 退回总部技术）') ? 'sales' : 'tech';
  const reason = prompt(`退回到${to === 'sales' ? '销售' : '总部技术'}的原因（缺资料 / 不可制造 / 与客户要求不符…）：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('退回必须写原因');
  busy.value = true;
  try {
    await api.rejectFa(cur.value.fa.id, { return_to: to, reason: reason.trim() });
    await refresh();
    alert('已退回，退回原因已写入工序备注');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function reopen() {
  busy.value = true;
  try {
    await api.reopenFa(cur.value.fa.id);
    await refresh();
    alert('已回到草稿，可修改检查项后重新提交');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function refreshVersion() {
  if (!confirm('按当前冻结版重做？会清空现有检查项，首件需重新测量')) return;
  busy.value = true;
  try {
    const r = await api.refreshFaVersion(cur.value.fa.id);
    await refresh();
    alert(`已指向 ${r.refreshed_to} 版，请重新生成检查项并测量`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(loadBoard);
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 19px; color: var(--ink); }
.page-head .sub { margin: 0; font-size: 12.5px; color: var(--ink-mute); max-width: 860px; line-height: 1.65; }
.page-head .sub b { color: var(--brand); }
.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 14px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 4px 0 2px; font-size: 21px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.amt-blue { color: var(--brand) !important; }
.row-red { background: #fff7f8; }
.row-warn { background: #fffdf5; }
.row-ng { background: #fff7f8; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.center { text-align: center; }
.ops { white-space: nowrap; }
.muted { color: var(--ink-mute); }
.sub-cell { font-size: 12px; color: #5b6474; }
.empty-cell { text-align: center; color: var(--ink-mute); padding: 16px; }
.table-wrap { overflow-x: auto; }
table.data th, table.data td { white-space: nowrap; }

.modal.xwide.fa-modal { width: 1320px; max-width: 98vw; }
.fa-modal .modal-body { max-height: 74vh; }
.fa-sum { display: grid; grid-template-columns: repeat(8, 1fr); gap: 10px; background: #f8fafd; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.fa-sum span { display: block; font-size: 12px; color: var(--ink-mute); }
.fa-sum b { font-size: 14px; color: var(--ink); font-variant-numeric: tabular-nums; }
.fa-warn { margin-bottom: 10px; padding: 8px 12px; background: #fff8f9; border: 1px solid #f8d3d8; border-radius: 8px; font-size: 12.5px; color: #b91c1c; line-height: 1.6; }
.fa-warn.warn-amber { background: #fffdf5; border-color: #f6e3b6; color: #a16207; }
.fa-sec { margin-top: 14px; }
.fa-sec-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.fa-sec h4 { margin: 0; font-size: 13px; color: var(--ink); }
.fa-ops { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.form-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5b6474; }
.form-grid .span2 { grid-column: span 2; }
.chk { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #5b6474; }
.input.cell, .select.cell { padding: 3px 6px; font-size: 12px; height: 26px; width: 100%; min-width: 60px; }
.input.cell.ta { height: auto; min-height: 42px; line-height: 1.45; resize: vertical; font-family: inherit; }
.nowrap { white-space: nowrap; }
table.data td.wrap { white-space: normal !important; line-height: 1.5; word-break: break-all; }
.input.mini { width: 80px; padding: 4px 8px; font-size: 12.5px; text-align: center; }
.ws-tbl { min-width: 1080px; }
.ck-tbl { min-width: 940px; }
.ev-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.release-box { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; background: var(--surface-2); }
.finish-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.finish-row label { font-size: 12.5px; color: #5b6474; }
@media (max-width: 1200px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .fa-sum { grid-template-columns: repeat(4, 1fr); }
  .form-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
