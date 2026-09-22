// Display formatting helpers.

export const pad2 = (n) => String(n).padStart(2, '0');

export function price(c, digits = 4) {
  return Number.isFinite(c) ? '$' + c.toFixed(digits) : '—';
}

export function pct(x, d = 1) {
  return Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—';
}

export function signedPct(x, d = 2) {
  if (!Number.isFinite(x)) return '—';
  const v = x * 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d) + '%';
}

export function bps(x, d = 1) {
  if (!Number.isFinite(x)) return '—';
  const v = x * 1e4;
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d) + ' bp';
}

export function hhmm(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

export function hhmmss(ms) {
  const d = new Date(ms);
  return hhmm(ms) + ':' + pad2(d.getSeconds());
}

export function countdown(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function horizonLabel(h) {
  return h >= 60 ? `${h / 60}h` : `${h}m`;
}

export function horizonWords(h) {
  return h >= 60 ? `${h / 60} hour` : `${h} minutes`;
}

export function num(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

export function dateShort(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
