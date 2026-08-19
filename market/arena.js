const TAU = Math.PI * 2;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hashSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function rgba(hex, alpha = 1) {
  const clean = String(hex || '#9adf83').replace('#', '');
  const expanded = clean.length === 3
    ? clean.split('').map((part) => part + part).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const value = Number.parseInt(expanded, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function assetColor(asset, index) {
  const fallback = ['#e7bf61', '#c8d5d7', '#bb7654', '#62b7d8', '#72d7b0', '#bd8de8'];
  return asset.visual?.primary || asset.color || asset.accent || fallback[index % fallback.length];
}

function assetBadge(asset) {
  if (asset.shortSymbol) return asset.shortSymbol;
  const [base] = String(asset.symbol || '').split('/');
  return base || asset.id.toUpperCase();
}

export class LiquidArena {
  constructor(canvas, { onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    this.onSelect = onSelect;
    this.frame = null;
    this.selectedId = null;
    this.displayShares = new Map();
    this.segments = [];
    this.pulses = [];
    this.pointer = { x: -1, y: -1 };
    this.motionAllowed = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement);
    this._handlePointer = this._handlePointer.bind(this);
    this._handleLeave = () => { this.pointer.x = -1; this.pointer.y = -1; };
    this._handleClick = this._handleClick.bind(this);
    canvas.addEventListener('pointermove', this._handlePointer);
    canvas.addEventListener('pointerleave', this._handleLeave);
    canvas.addEventListener('click', this._handleClick);
    this.resize();
    this._raf = requestAnimationFrame((time) => this.draw(time));
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.pixelRatio = ratio;
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  setFrame(frame) {
    if (!frame?.assets?.length) return;
    this.frame = frame;
    if (!this.selectedId || !frame.assets.some((asset) => asset.id === this.selectedId)) {
      this.selectedId = frame.leader?.id || frame.assets[0].id;
    }
    for (const asset of frame.assets) {
      const share = Number(asset.dominancePct ?? asset.dominance ?? 0);
      if (!this.displayShares.has(asset.id)) this.displayShares.set(asset.id, share);
    }
  }

  setSelected(assetId) {
    this.selectedId = assetId;
  }

  triggerEvent(event) {
    if (!event?.assetId || !this.frame) return;
    const assetIndex = this.frame.assets.findIndex((asset) => asset.id === event.assetId);
    if (assetIndex < 0) return;
    this.pulses.push({ assetId: event.assetId, born: performance.now(), magnitude: clamp(event.magnitude || 1, 0.3, 2.5) });
    if (this.pulses.length > 8) this.pulses.shift();
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._resizeObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this._handlePointer);
    this.canvas.removeEventListener('pointerleave', this._handleLeave);
    this.canvas.removeEventListener('click', this._handleClick);
  }

  _handlePointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = event.clientX - rect.left;
    this.pointer.y = event.clientY - rect.top;
    const segment = this._segmentAt(this.pointer.x, this.pointer.y);
    this.canvas.style.cursor = segment ? 'pointer' : 'default';
  }

  _handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const segment = this._segmentAt(event.clientX - rect.left, event.clientY - rect.top);
    if (!segment) return;
    this.selectedId = segment.asset.id;
    this.onSelect(segment.asset.id);
  }

  _segmentAt(x, y) {
    if (!this.geometry) return null;
    const { cx, cy, innerRadius, outerRadius } = this.geometry;
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance < innerRadius || distance > outerRadius * 1.09) return null;
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += TAU;
    return this.segments.find((segment) => angle >= segment.start && angle < segment.end) || this.segments.at(-1) || null;
  }

  _radiusAt(angle, time, asset, outerRadius, inner = false) {
    const volatility = clamp(Number(
      asset.visual?.turbulence
      ?? asset.volatilityScore
      ?? asset.volatility
      ?? Math.min(1, (asset.volatilityPct || 0) * 2)
      ?? 0.4,
    ), 0.05, 2);
    const phase = hashSeed(asset.id || asset.symbol || '') * TAU;
    const speed = this.motionAllowed ? time * (0.00022 + volatility * 0.00009) : 0;
    const primary = Math.sin(angle * 6 + speed + phase);
    const secondary = Math.sin(angle * 11 - speed * 0.7 + phase * 1.9);
    const amplitude = inner ? 0.022 + volatility * 0.007 : 0.018 + volatility * 0.012;
    return outerRadius * (1 + primary * amplitude + secondary * amplitude * 0.42);
  }

  _point(radius, angle, cx, cy) {
    const theta = angle - Math.PI / 2;
    return { x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius };
  }

  _buildSegmentPath(ctx, segment, time, geometry) {
    const { cx, cy, innerRadius, outerRadius } = geometry;
    const span = Math.max(0.001, segment.end - segment.start);
    const gap = Math.min(0.012, span * 0.08);
    const start = segment.start + gap;
    const end = segment.end - gap;
    const steps = Math.max(12, Math.ceil(span * 30));

    ctx.beginPath();
    for (let step = 0; step <= steps; step += 1) {
      const angle = start + (end - start) * (step / steps);
      const radius = this._radiusAt(angle, time, segment.asset, outerRadius);
      const point = this._point(radius, angle, cx, cy);
      if (step === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    for (let step = steps; step >= 0; step -= 1) {
      const angle = start + (end - start) * (step / steps);
      const radius = this._radiusAt(angle, time * 0.83, segment.asset, innerRadius, true);
      const point = this._point(radius, angle, cx, cy);
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
  }

  _drawScaffold(ctx, geometry, time) {
    const { cx, cy, outerRadius, innerRadius } = geometry;
    ctx.save();
    ctx.translate(0.5, 0.5);
    for (const ratio of [1.13, 1, 0.76, 0.51, innerRadius / outerRadius]) {
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius * ratio, 0, TAU);
      ctx.strokeStyle = ratio === 1 ? 'rgba(184, 211, 194, .13)' : 'rgba(184, 211, 194, .055)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (let index = 0; index < 24; index += 1) {
      const angle = (index / 24) * TAU;
      const start = this._point(outerRadius * 1.055, angle, cx, cy);
      const length = index % 6 === 0 ? 0.065 : 0.035;
      const end = this._point(outerRadius * (1.055 + length), angle, cx, cy);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = index % 6 === 0 ? 'rgba(184, 211, 194, .18)' : 'rgba(184, 211, 194, .07)';
      ctx.stroke();
    }
    const sweep = this.motionAllowed ? (time * 0.00004) % TAU : 0.8;
    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius * 1.12, sweep, sweep + Math.PI * 0.22);
    ctx.strokeStyle = 'rgba(185, 243, 90, .35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  _drawTerritories(ctx, time, geometry) {
    if (!this.frame) return;
    const targetAssets = this.frame.assets;
    let total = 0;
    for (const asset of targetAssets) {
      const target = Number(asset.dominancePct ?? asset.dominance ?? 0);
      const current = this.displayShares.get(asset.id) ?? target;
      const next = current + (target - current) * (this.motionAllowed ? 0.055 : 1);
      this.displayShares.set(asset.id, next);
      total += next;
    }
    total = total || 100;

    let cursor = 0;
    this.segments = targetAssets.map((asset, index) => {
      const share = this.displayShares.get(asset.id) || 0;
      const start = cursor;
      const end = index === targetAssets.length - 1 ? TAU : cursor + TAU * share / total;
      cursor = end;
      return { asset, index, start, end, share };
    });

    for (const segment of this.segments) {
      const color = assetColor(segment.asset, segment.index);
      const selected = segment.asset.id === this.selectedId;
      const hovered = this._segmentAt(this.pointer.x, this.pointer.y)?.asset.id === segment.asset.id;
      this._buildSegmentPath(ctx, segment, time, geometry);

      const middle = (segment.start + segment.end) / 2;
      const source = this._point(geometry.innerRadius * 0.9, middle, geometry.cx, geometry.cy);
      const target = this._point(geometry.outerRadius * 1.05, middle, geometry.cx, geometry.cy);
      const fill = ctx.createLinearGradient(source.x, source.y, target.x, target.y);
      fill.addColorStop(0, rgba(color, selected ? 0.72 : 0.47));
      fill.addColorStop(0.55, rgba(color, selected || hovered ? 0.69 : 0.56));
      fill.addColorStop(1, rgba(color, selected ? 0.38 : 0.2));
      ctx.fillStyle = fill;
      ctx.shadowColor = rgba(color, selected ? 0.42 : 0.14);
      ctx.shadowBlur = selected ? 28 : 11;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = rgba(color, selected ? 0.92 : 0.36);
      ctx.lineWidth = selected ? 1.6 : 0.75;
      ctx.stroke();

      ctx.save();
      this._buildSegmentPath(ctx, segment, time, geometry);
      ctx.clip();
      this._drawFlowLines(ctx, segment, time, geometry, color);
      ctx.restore();
    }
  }

  _drawFlowLines(ctx, segment, time, geometry, color) {
    const span = segment.end - segment.start;
    const phase = hashSeed(segment.asset.id || '') * TAU;
    for (let line = 0; line < 5; line += 1) {
      const radius = geometry.innerRadius + (geometry.outerRadius - geometry.innerRadius) * ((line + 1) / 6);
      ctx.beginPath();
      const steps = Math.max(8, Math.ceil(span * 18));
      for (let step = 0; step <= steps; step += 1) {
        const angle = segment.start + span * step / steps;
        const drift = Math.sin(angle * 8 + phase + time * 0.00025 + line) * geometry.outerRadius * 0.007;
        const point = this._point(radius + drift, angle, geometry.cx, geometry.cy);
        if (step === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.strokeStyle = rgba(color, line % 2 ? 0.10 : 0.17);
      ctx.lineWidth = line % 2 ? 0.7 : 1;
      ctx.stroke();
    }
  }

  _drawPulses(ctx, time, geometry) {
    this.pulses = this.pulses.filter((pulse) => time - pulse.born < 2100);
    for (const pulse of this.pulses) {
      const segment = this.segments.find((entry) => entry.asset.id === pulse.assetId);
      if (!segment) continue;
      const progress = clamp((time - pulse.born) / 2100, 0, 1);
      const angle = (segment.start + segment.end) / 2;
      const center = this._point(geometry.outerRadius * 0.73, angle, geometry.cx, geometry.cy);
      const color = assetColor(segment.asset, segment.index);
      ctx.beginPath();
      ctx.arc(center.x, center.y, 8 + progress * geometry.outerRadius * 0.28 * pulse.magnitude, 0, TAU);
      ctx.strokeStyle = rgba(color, (1 - progress) * 0.72);
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
  }

  _drawLabels(ctx, geometry) {
    for (const segment of this.segments) {
      const span = segment.end - segment.start;
      if (span < 0.19) continue;
      const midpoint = (segment.start + segment.end) / 2;
      const radius = geometry.innerRadius + (geometry.outerRadius - geometry.innerRadius) * 0.58;
      const point = this._point(radius, midpoint, geometry.cx, geometry.cy);
      const color = assetColor(segment.asset, segment.index);
      const symbol = assetBadge(segment.asset);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(239, 246, 240, .86)';
      ctx.font = `600 ${span < 0.38 ? 9 : 11}px "IBM Plex Mono"`;
      ctx.fillText(symbol, point.x, point.y - 6);
      ctx.fillStyle = rgba(color, 0.94);
      ctx.font = `600 ${span < 0.38 ? 8 : 10}px "Barlow Condensed"`;
      ctx.fillText(`${segment.share.toFixed(1)}%`, point.x, point.y + 7);
      ctx.restore();
    }
  }

  _drawCore(ctx, time, geometry) {
    const { cx, cy, innerRadius } = geometry;
    const glow = ctx.createRadialGradient(cx, cy, innerRadius * 0.15, cx, cy, innerRadius * 1.18);
    glow.addColorStop(0, 'rgba(93, 142, 117, .16)');
    glow.addColorStop(0.7, 'rgba(21, 46, 37, .18)');
    glow.addColorStop(1, 'rgba(4, 10, 8, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius * 1.2, 0, TAU);
    ctx.fillStyle = glow;
    ctx.fill();

    const rotation = this.motionAllowed ? time * 0.00005 : 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    for (let index = 0; index < 3; index += 1) {
      ctx.beginPath();
      ctx.arc(0, 0, innerRadius * (0.73 + index * 0.11), index * 1.7, index * 1.7 + 1.15);
      ctx.strokeStyle = `rgba(185, 243, 90, ${0.13 - index * 0.025})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  draw(time = 0) {
    const ctx = this.context;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const outerRadius = Math.max(80, Math.min(this.width, this.height) * (this.width < 500 ? 0.39 : 0.405));
    const geometry = {
      cx: this.width / 2,
      cy: this.height / 2 + (this.width < 500 ? 4 : 8),
      outerRadius,
      innerRadius: outerRadius * 0.255,
    };
    this.geometry = geometry;

    this._drawScaffold(ctx, geometry, time);
    this._drawTerritories(ctx, time, geometry);
    this._drawPulses(ctx, time, geometry);
    this._drawLabels(ctx, geometry);
    this._drawCore(ctx, time, geometry);

    this._raf = requestAnimationFrame((nextTime) => this.draw(nextTime));
  }
}
