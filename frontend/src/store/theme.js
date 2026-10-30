import { reactive } from 'vue';

const KEY = 'erp_theme';
const saved = localStorage.getItem(KEY);
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const theme = reactive({ mode: saved || (prefersDark ? 'dark' : 'light') });

export function applyTheme(mode = theme.mode) {
  theme.mode = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme.mode;
  document.documentElement.style.colorScheme = theme.mode;
  localStorage.setItem(KEY, theme.mode);
}

export function toggleTheme() {
  applyTheme(theme.mode === 'dark' ? 'light' : 'dark');
}

applyTheme();
