const { db } = require('./src/db');
const cols = (t) => {
  try { console.log('==' + t + '==\n  ' + db.prepare('PRAGMA table_info(' + t + ')').all().map((x) => x.name).join(', ')); }
  catch (e) { console.log('==' + t + '== 无'); }
};
['employees', 'payrolls', 'payroll_items', 'customers', 'suppliers', 'bank_accounts', 'admin_contracts'].forEach(cols);
console.log('\n员工数:', db.prepare('SELECT COUNT(*) c FROM employees').get().c);
console.log('工资单数:', db.prepare('SELECT COUNT(*) c FROM payrolls').get().c);
