// LAN HTTP 不保证 randomUUID 可用；getRandomValues 在非安全上下文仍可使用。
export function entryId(){const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
export const entryRound=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
