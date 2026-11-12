let current;
const controls = 'input:not([type=hidden]), select, textarea, [contenteditable=true]';
const visible = element => element.getClientRects().length > 0;
function clear() {
  if (!current) return;
  const {target, note, previous} = current;
  target.classList.remove('erp-invalid');
  if (previous === null) target.removeAttribute('aria-invalid');
  else target.setAttribute('aria-invalid', previous);
  target.removeEventListener('input', clear);
  target.removeEventListener('change', clear);
  note.remove();
  current = null;
}
export function showFieldError(target, message) {
  clear();
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  const note = document.createElement('div');
  note.className = 'erp-validation-message';
  note.setAttribute('role','alert');
  note.textContent = message;
  current = {target, note, previous:target.getAttribute('aria-invalid')};
  target.classList.add('erp-invalid');
  target.setAttribute('aria-invalid','true');
  target.after(note);
  target.addEventListener('input', clear);
  target.addEventListener('change', clear);
  target.scrollIntoView({block:'center', inline:'nearest'});
  target.focus({preventScroll:true});
}
function reportMessage(message) {
  const dialogs = [...document.querySelectorAll('.modal,[role=dialog],dialog[open]')].filter(visible);
  const scope = dialogs.at(-1) || document.querySelector('.erp-content') || document.body;
  const fields = [...scope.querySelectorAll(controls)].filter(el => visible(el) && !el.disabled && !el.readOnly);
  const target = fields.find(el => el.validity && !el.validity.valid) || fields.find(el => {
    const labels = [...(el.labels || [])].map(label => label.textContent);
    labels.push(el.getAttribute('aria-label'), el.placeholder, el.closest('.fitem,.form-item')?.querySelector('label')?.textContent);
    return labels.some(label => label && message.includes(label.replace(/[：:*＊\s]/g,'')) && label.replace(/[：:*＊\s]/g,'').length >= 2);
  });
  const action = scope.contains(document.activeElement) && document.activeElement.matches('button') ? document.activeElement : null;
  showFieldError(target || action || scope.querySelector('h2,h3') || scope.firstElementChild || scope, message);
}
export function installValidationFeedback() {
  let firstInvalid;
  document.addEventListener('invalid', event => {
    event.preventDefault();
    if (firstInvalid) return;
    firstInvalid = event.target;
    queueMicrotask(() => {
      const field = firstInvalid;
      firstInvalid = null;
      if (field.isConnected) showFieldError(field, field.validationMessage);
    });
  }, true);
  const nativeAlert = window.alert.bind(window);
  window.alert = value => {
    const message = String(value);
    if (/成功|已复制|已保存|已提交|已生成|已完成/.test(message) && !/失败|错误|无效|未|不能|请先/.test(message)) return nativeAlert(message);
    reportMessage(message);
  };
}
