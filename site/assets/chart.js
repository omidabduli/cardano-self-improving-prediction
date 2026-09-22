// Canvas chart: live price, the band that was predicted for each moment, the forward
// forecast fan and a strip of hit/miss results underneath.

import { hhmm } from './format.js';

const PAD = { l: 8, r: 70, t: 16, b: 26 };
const MIN = 60000;

function niceStep(range, target) {
  const raw = range / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

export class ForecastChart {
  constructor(canvas, { tip, dot, strip }) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.tip = tip;
    this.dot = dot;
    this.strip = strip;
    this.sctx = strip.getContext('2d');
    this.data = null;
    this.hoverX = null;
    this.raf = 0;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    const move = (clientX, clientY) => {
      const r = this.c.getBoundingClientRect();
      this.hoverX = clientX - r.left;
      this.hoverY = clientY - r.top;
      this.schedule();
    };
    canvas.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.schedule(); });
    canvas.addEventListener('touchstart', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    canvas.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    canvas.addEventListener('touchend', () => { setTimeout(() => { this.hoverX = null; this.schedule(); }, 2500); });
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const r = this.c.parentElement.getBoundingClientRect();
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    const sr = this.strip.getBoundingClientRect();
    this.sw = sr.width; this.sh = sr.height;
    this.strip.width = Math.round(sr.width * dpr); this.strip.height = Math.round(sr.height * dpr);
    this.schedule();
  }

  set(data) { this.data = data; this.schedule(); }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw() {
    const d = this.data, ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!d || !d.points.length) { this.dot.style.display = 'none'; return; }
    const W = this.w - PAD.l - PAD.r, H = this.h - PAD.t - PAD.b;
    const { x0, x1 } = d;
    const X = (t) => PAD.l + ((t - x0) / (x1 - x0)) * W;
    const T = (px) => x0 + ((px - PAD.l) / W) * (x1 - x0);

    // ----- y range from what is visible -----
    let lo = Infinity, hi = -Infinity;
    const take = (v) => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (const p of d.points) if (p.x >= x0) take(p.y);
    for (const c of d.corridor) if (c.x >= x0 && c.x <= x1) { take(c.lo); take(c.hi); }
    if (d.fan) for (const s of d.fan.steps) { take(s.lo80); take(s.hi80); }
    if (!(hi > lo)) { hi = lo * 1.001 + 1e-9; lo = lo * 0.999; }
    const padY = (hi - lo) * 0.1;
    lo -= padY; hi += padY;
    const Y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * H;
    this.map = { X, Y, T, lo, hi };

    // ----- grid -----
    ctx.lineWidth = 1;
    ctx.font = '10.5px JetBrains Mono, monospace';
    ctx.textBaseline = 'middle';
    const pStep = niceStep(hi - lo, Math.max(3, Math.round(H / 60)));
    const decimals = Math.max(4, Math.min(6, -Math.floor(Math.log10(pStep))));
    for (let v = Math.ceil(lo / pStep) * pStep; v <= hi; v += pStep) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = 'rgba(148,170,220,0.07)';
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + W, y); ctx.stroke();
      ctx.fillStyle = 'rgba(163,177,204,0.55)';
      ctx.textAlign = 'left';
      ctx.fillText(v.toFixed(decimals), PAD.l + W + 8, y);
    }
    const span = (x1 - x0) / MIN;
    const tStep = [5, 10, 15, 30, 60, 120, 180, 360].find((m) => (W / span) * m >= 78) || 360;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // ticks on round local-time minutes (getTimezoneOffset = UTC - local, in minutes)
    const tz = new Date().getTimezoneOffset();
    for (let L = Math.ceil((x0 / MIN - tz) / tStep) * tStep; (L + tz) * MIN <= x1; L += tStep) {
      const t = (L + tz) * MIN;
      const x = Math.round(X(t)) + 0.5;
      if (x < PAD.l + 10 || x > PAD.l + W - 10) continue;
      ctx.strokeStyle = 'rgba(148,170,220,0.05)';
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + H); ctx.stroke();
      ctx.fillStyle = 'rgba(163,177,204,0.5)';
      ctx.fillText(hhmm(t), x, PAD.t + H + 8);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, PAD.t - 4, W, H + 8); ctx.clip();

    // ----- corridor: what was predicted for each moment -----
    const segs = [];
    let cur = [];
    for (const c of d.corridor) {
      if (c.x < x0 - MIN || c.x > x1) continue;
      if (cur.length && c.x - cur[cur.length - 1].x > 1.5 * MIN) { segs.push(cur); cur = []; }
      cur.push(c);
    }
    if (cur.length) segs.push(cur);
    for (const s of segs) {
      if (s.length < 2) continue;
      ctx.beginPath();
      s.forEach((c, i) => (i ? ctx.lineTo(X(c.x), Y(c.hi)) : ctx.moveTo(X(c.x), Y(c.hi))));
      for (let i = s.length - 1; i >= 0; i--) ctx.lineTo(X(s[i].x), Y(s[i].lo));
      ctx.closePath();
      ctx.fillStyle = 'rgba(91,140,255,0.13)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(91,140,255,0.38)';
      for (const key of ['hi', 'lo']) {
        ctx.beginPath();
        s.forEach((c, i) => (i ? ctx.lineTo(X(c.x), Y(c[key])) : ctx.moveTo(X(c.x), Y(c[key]))));
        ctx.stroke();
      }
    }

    // ----- price area + line -----
    const pts = d.points.filter((p) => p.x >= x0 - 2 * MIN);
    if (pts.length > 1) {
      const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + H);
      grad.addColorStop(0, 'rgba(91,140,255,0.22)');
      grad.addColorStop(1, 'rgba(91,140,255,0)');
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.lineTo(X(pts[pts.length - 1].x), PAD.t + H);
      ctx.lineTo(X(pts[0].x), PAD.t + H);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#d6e3ff';
      ctx.shadowColor = 'rgba(91,140,255,0.85)';
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ----- forecast fan -----
    if (d.fan) {
      const f = d.fan;
      const xs = f.steps.map((s) => X(s.x));
      const xa = X(f.x0), xb = xs[xs.length - 1];
      const col = f.dir > 0 ? '34,227,154' : f.dir < 0 ? '255,77,121' : '46,230,197';
      const bands = [['lo95', 'hi95', 0.1], ['lo80', 'hi80', 0.16], ['lo50', 'hi50', 0.24]];
      for (const [kl, kh, a] of bands) {
        const g = ctx.createLinearGradient(xa, 0, xb, 0);
        g.addColorStop(0, `rgba(${col},${a * 1.6})`);
        g.addColorStop(1, `rgba(${col},${a * 0.45})`);
        ctx.beginPath();
        ctx.moveTo(xa, Y(f.y0));
        f.steps.forEach((s, i) => ctx.lineTo(xs[i], Y(s[kh])));
        for (let i = f.steps.length - 1; i >= 0; i--) ctx.lineTo(xs[i], Y(f.steps[i][kl]));
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `rgba(${col},0.95)`;
      ctx.beginPath();
      ctx.moveTo(xa, Y(f.y0));
      f.steps.forEach((s, i) => ctx.lineTo(xs[i], Y(s.mid)));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ----- now line -----
    const xn = X(d.now);
    ctx.strokeStyle = 'rgba(232,238,251,0.28)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(Math.round(xn) + 0.5, PAD.t); ctx.lineTo(Math.round(xn) + 0.5, PAD.t + H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.font = '600 10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(232,238,251,0.55)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('NOW', xn, 2);
    if (d.fan) {
      ctx.fillStyle = 'rgba(46,230,197,0.7)';
      ctx.fillText('+1H', X(d.fan.steps[d.fan.steps.length - 1].x) - 12, 2);
    }

    // ----- live price tag on the axis -----
    if (d.live) {
      const y = Y(d.live.y);
      ctx.fillStyle = '#3a6bf0';
      const tagW = PAD.r - 6, tagH = 20;
      ctx.beginPath();
      ctx.roundRect(PAD.l + W + 3, y - tagH / 2, tagW, tagH, 5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '600 11px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(d.live.y.toFixed(4), PAD.l + W + 9, y + 0.5);
      ctx.strokeStyle = 'rgba(91,140,255,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xn, y); ctx.lineTo(PAD.l + W, y); ctx.stroke();
      ctx.setLineDash([]);
      this.dot.style.display = 'block';
      this.dot.style.transform = `translate(${xn}px, ${y}px)`;
    } else this.dot.style.display = 'none';

    // ----- hover -----
    if (this.hoverX !== null && this.hoverX > PAD.l && this.hoverX < PAD.l + W && d.lookup) {
      const t = Math.round(T(this.hoverX) / MIN) * MIN;
      const html = d.lookup(t);
      const x = X(t);
      ctx.strokeStyle = 'rgba(232,238,251,0.35)';
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, PAD.t); ctx.lineTo(Math.round(x) + 0.5, PAD.t + H); ctx.stroke();
      if (html) {
        this.tip.innerHTML = html;
        this.tip.hidden = false;
        const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
        let left = x + 14;
        if (left + tw > this.w - 4) left = x - tw - 14;
        const top = Math.max(4, Math.min(this.h - th - 4, (this.hoverY ?? 40) - th / 2));
        this.tip.style.left = left + 'px';
        this.tip.style.top = top + 'px';
      } else this.tip.hidden = true;
    } else this.tip.hidden = true;

    this.drawStrip(X, W);
  }

  drawStrip(X, W) {
    const d = this.data, ctx = this.sctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.sw, this.sh);
    // the strip canvas starts after its label; map chart x into strip coordinates
    const off = this.strip.getBoundingClientRect().left - this.c.getBoundingClientRect().left;
    const pxMin = (W / ((d.x1 - d.x0) / MIN));
    const w = Math.max(1, pxMin - (pxMin > 3 ? 1 : 0));
    ctx.fillStyle = 'rgba(148,170,220,0.06)';
    ctx.fillRect(0, 0, this.sw, this.sh);
    for (const r of d.results) {
      if (r.x < d.x0 || r.x > d.x1) continue;
      const x = X(r.x) - off - w / 2;
      if (x + w < 0 || x > this.sw) continue;
      ctx.fillStyle = r.s === 1 ? '#22e39a' : r.s === 0 ? '#ff4d79' : '#3b4760';
      ctx.fillRect(x, 2, w, this.sh - 4);
    }
  }
}
