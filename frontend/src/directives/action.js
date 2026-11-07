/** 声明按钮动作，响应权限更新；后端仍独立校验每次提交。 */
import { shallowRef, watchEffect } from 'vue';
import { canAction } from '../store/permissions';
const entries = new WeakMap();
export const actionDirective = {
 mounted(el, binding) {
  const value = shallowRef(binding.value);
  const stop = watchEffect(() => {
   const [module, action] = value.value || [];
   el.toggleAttribute('data-action-denied', !!module && !canAction(module, action));
  });
  const guard = event => { if (el.hasAttribute('data-action-denied')) { event.preventDefault(); event.stopImmediatePropagation(); } };
  el.addEventListener('click', guard, true);
  entries.set(el, {value, stop, guard});
 },
 updated(el, binding) {
  const entry=entries.get(el);
  // 模板数组每次渲染都会创建新引用；相同动作不重复触发响应式更新。
  if(entry && (entry.value.value?.[0]!==binding.value?.[0] || entry.value.value?.[1]!==binding.value?.[1]))entry.value.value=binding.value;
 },
 unmounted(el) { const entry=entries.get(el);if(entry){entry.stop();el.removeEventListener('click',entry.guard,true);entries.delete(el);} }
};
