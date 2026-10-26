import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './store/auth';

import Login from './views/Login.vue';
import ErpLayout from './layouts/ErpLayout.vue';
import Dashboard from './views/Dashboard.vue';
import Customers from './views/Customers.vue';
import Products from './views/Products.vue';
import Orders from './views/Orders.vue';
import Development from './views/Development.vue';
import Blueprint from './views/Blueprint.vue';
import Settings from './views/Settings.vue';

const routes = [
  { path: '/login', component: Login, meta: { public: true } },
  {
    path: '/',
    component: ErpLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', component: Dashboard, meta: { title: '工作台' } },
      { path: 'customers', component: Customers, meta: { title: '客户管理' } },
      { path: 'products', component: Products, meta: { title: '产品管理' } },
      { path: 'orders', component: Orders, meta: { title: '销售订单' } },
      { path: 'development', component: Development, meta: { title: '开发管理' } },
      { path: 'blueprint', component: Blueprint, meta: { title: '业务蓝图' } },
      { path: 'settings', component: Settings, meta: { title: '系统设置' } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!auth.token) return '/login';
  return true;
});

export default router;
