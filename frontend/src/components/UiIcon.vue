<template><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.archive" /></svg></template>
<script setup>
defineProps({name:String});
const paths={
 dash:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
 self:'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 exceptions:'M12 3 2 21h20L12 3zM12 9v5M12 17h.01',
 scan:'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10',
 assist:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z',
 mail:'M3 5h18v14H3zM3 6l9 7 9-7',
 archive:'M3 7h7l2-3h9v16H3V7zM3 9h18',
 sales:'M5 7h14l2 14H3L5 7zM9 7V5a3 3 0 0 1 6 0v2',
 retail:'M3 3h8l10 10-8 8L3 11V3zM7 7h.01',
 tech:'m14 6 4-3 3 3-3 4-4-4zM14 6 3 17l4 4L18 10M5 15l4 4',
 purchase:'M4 7h16l-1 14H5L4 7zM8 7V5a4 4 0 0 1 8 0v2',
 prod:'M3 21V9l6 3V7l6 5V3h6v18H3zM7 17h1M12 17h1M17 17h1',
 stock:'m3 7 9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10M7 5l9 4',
 approve:'M9 4H4v17h16V4h-5M9 2h6v5H9zM8 14l3 3 5-6',
 finance:'M3 6h18v15H3V6zM3 6V3h15M15 11h6v5h-6z',
 hr:'M3 21V3h12v18M15 9h6v12M7 7h4M7 11h4M7 15h4M7 21v-2h4v2',
 sys:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
 palette:'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 1.5 1.5 0 0 1 0-3h3a4 4 0 0 0 4-4 9 9 0 0 0-9-7zM7 10h.01M10 7h.01M15 7h.01M18 10h.01'
};
</script>
