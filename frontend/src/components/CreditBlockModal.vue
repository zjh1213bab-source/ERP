<template>
  <div v-if="modelValue" class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>信用受限，这张单不能发</h3>
        <button class="x" @click="$emit('close')">×</button>
      </div>
      <div class="modal-body">
        <div class="banner bad">
          <b>{{ orderNo || '这张单' }} 被信用闸门拦下了</b>
          <span>
            拦的是「货出门」这一步，不是不让你做单。<b>货一旦离厂，钱和货都不在自己手上</b>，
            所以这里必须先说清楚怎么办。
          </span>
        </div>

        <!-- 硬理由：为什么不能发 -->
        <ul class="reasons">
          <li v-for="(r, i) in reasons" :key="i">{{ r }}</li>
        </ul>

        <!-- 客户画像：让人一眼判断是「该催款」还是「该调额度」 -->
        <div v-if="profile" class="figs">
          <div><label>客户</label><b>{{ profile.customer_name }}</b></div>
          <div><label>信用额度</label><b>{{ money(profile.limit) }}</b></div>
          <div><label>当前敞口</label><b>{{ money(profile.exposure) }}</b></div>
          <div>
            <label>可用</label>
            <b :style="{ color: profile.available < 0 ? '#d92d45' : '#16a34a' }">{{ money(profile.available) }}</b>
          </div>
          <div><label>逾期</label><b :style="{ color: profile.overdue ? '#d92d45' : '' }">{{ money(profile.overdue) }}<template v-if="profile.max_overdue_days"> / {{ profile.max_overdue_days }} 天</template></b></div>
          <div><label>账期</label><b>{{ profile.credit_days }} 天</b></div>
        </div>

        <!-- 提示（不拦但要知道） -->
        <div v-if="notes.length || tips.length" class="tips">
          <div v-for="(n, i) in notes" :key="'n' + i" class="tip warn">• {{ n }}</div>
          <div v-for="(t, i) in tips" :key="'t' + i" class="tip">• {{ t }}</div>
        </div>

        <!-- 出路一：办放行单（有权限的人当场办） -->
        <div v-if="canRelease" class="release">
          <h4>出路：办一张放行单</h4>
          <p class="tiny muted">
            放行单是「这次例外」的凭据，<b>只能用一次、绑死这张单</b>。
            理由要写清楚为什么可以例外（至少 8 个字）—— 审计只会看这句话。
          </p>
          <div class="rrow">
            <input v-model="reason" class="input" placeholder="例如：客户已付 30% 定金，财务总监同意先发货，余款 11/15 前结清" />
            <button class="btn btn-primary" :disabled="busy || reason.trim().length < 8" @click="doRelease">
              {{ busy ? '提交中…' : '办放行并发货' }}
            </button>
          </div>
        </div>
        <div v-else class="release">
          <h4>出路</h4>
          <p class="tiny muted">
            放行单要财务或管理员开。请联系财务，或让客户先回款、或由财务调整额度。
          </p>
        </div>

        <div class="form-foot">
          <button class="btn btn-ghost" @click="$emit('close')">关闭</button>
          <button class="btn btn-ghost" @click="goCredit">去信用台账看这家客户</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  check: { type: Object, default: null },   // credit.judge 的返回
  orderId: { type: [Number, String], default: null },
  orderNo: { type: String, default: '' },
  // 从哪个仓发（cn/us）。放行后要接着发，得知道发哪儿
  warehouse: { type: String, default: 'cn' }
});
const emit = defineEmits(['close', 'released']);

const router = useRouter();
const reason = ref('');
const busy = ref(false);

const reasons = computed(() => (props.check && props.check.reasons) || []);
const notes = computed(() => (props.check && props.check.notes) || []);
const tips = computed(() => (props.check && props.check.tips) || []);
const profile = computed(() => (props.check && props.check.profile) || null);
const canRelease = computed(() => can('credit.write'));

const money = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

watch(
  () => props.modelValue,
  (v) => { if (v) reason.value = ''; }
);

async function doRelease() {
  if (String(reason.value || '').trim().length < 8) return;
  busy.value = true;
  try {
    const ov = await api.creditOverride({ order_id: props.orderId, reason: reason.value.trim() });
    // 办完立刻接着发：让用户少点一次，也避免「办了放行单但忘了发货」
    await api.orderShip({
      order_id: props.orderId,
      warehouse: props.warehouse,
      credit_override_id: ov.id
    });
    emit('released', ov);
    emit('close');
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function goCredit() {
  const id = profile.value && profile.value.customer_id;
  router.push(id ? `/credit?focus=${id}` : '/credit');
  emit('close');
}
</script>

<style scoped>
.banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-radius: 12px; margin-bottom: 14px; font-size: 13px; line-height: 1.7; border: 1px solid transparent; }
.banner.bad { background: #fdecee; border-color: #f6c9d0; color: #9c1c30; }

.reasons { margin: 0 0 14px; padding-left: 20px; color: #9c1c30; font-size: 13px; line-height: 1.9; font-weight: 600; }

.figs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 16px; padding: 12px 14px; background: #f7f9fc; border-radius: 12px; margin-bottom: 12px; }
.figs label { display: block; font-size: 11.5px; color: #8a94a6; margin-bottom: 3px; }
.figs b { font-size: 14px; color: #16233b; }

.tips { margin-bottom: 12px; }
.tip { font-size: 12.5px; color: #6b7688; line-height: 1.9; }
.tip.warn { color: #b45309; }

.release { border-top: 1px dashed #e6ebf3; padding-top: 14px; margin-bottom: 6px; }
.release h4 { margin: 0 0 6px; font-size: 13.5px; color: #16233b; }
.release .tiny { margin: 0 0 10px; line-height: 1.7; }
.rrow { display: flex; gap: 10px; }
.rrow .input { flex: 1; }

.form-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }

@media (max-width: 900px) {
  .figs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rrow { flex-direction: column; }
}
</style>
