export type Pt = { x: number; y: number };

export type Stroke = {
  type: "stroke";
  points: Pt[];
  color: string;
  width: number;
  opacity: number;
  highlight?: boolean;
};

export type LineObj = {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  opacity: number;
};

export type ShapeObj = {
  type: "rect" | "circle";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  width: number;
  opacity: number;
};

export type TextObj = {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  opacity: number;
};

export type DrawObj = Stroke | LineObj | ShapeObj | TextObj;

export type MediaObj = {
  id: string;
  kind: "image" | "video";
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export const COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#111111",
  "#ffffff",
] as const;

export function colorName(c: string) {
  if (c === "#111111") return "Black";
  if (c === "#ffffff") return "White";
  return `Color ${c}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function strokeCommands(points: Pt[]) {
  if (!points.length) return "";
  if (points.length === 1) {
    return `M ${r2(points[0].x)} ${r2(points[0].y)} l 0.2 0.2`;
  }
  let d = `M ${r2(points[0].x)} ${r2(points[0].y)}`;
  if (points.length === 2) {
    return `${d} L ${r2(points[1].x)} ${r2(points[1].y)}`;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${r2(points[i].x)} ${r2(points[i].y)} ${r2(mx)} ${r2(my)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${r2(last.x)} ${r2(last.y)}`;
  return d;
}

export function boundsOf(o: DrawObj) {
  if (o.type === "stroke") {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of o.points) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const pad = o.width;
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }
  if (o.type === "text") {
    const w = Math.max(24, o.text.length * o.fontSize * 0.56);
    return { x0: o.x, y0: o.y - o.fontSize, x1: o.x + w, y1: o.y };
  }
  if (o.type === "line" || o.type === "arrow") {
    return {
      x0: Math.min(o.x1, o.x2),
      y0: Math.min(o.y1, o.y2),
      x1: Math.max(o.x1, o.x2),
      y1: Math.max(o.y1, o.y2),
    };
  }
  return {
    x0: Math.min(o.x, o.x + o.w),
    y0: Math.min(o.y, o.y + o.h),
    x1: Math.max(o.x, o.x + o.w),
    y1: Math.max(o.y, o.y + o.h),
  };
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitObj(o: DrawObj, x: number, y: number, radius: number) {
  if (o.type === "stroke") {
    const reach = radius + o.width * 0.5;
    const pts = o.points;
    if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= reach;
    for (let i = 1; i < pts.length; i++) {
      if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= reach) return true;
    }
    return false;
  }
  if (o.type === "line" || o.type === "arrow") {
    return distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= radius + o.width;
  }
  const b = boundsOf(o);
  return x >= b.x0 - radius && x <= b.x1 + radius && y >= b.y0 - radius && y <= b.y1 + radius;
}

export function drawObj(ctx: CanvasRenderingContext2D, o: DrawObj) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = Math.max(0.05, Math.min(1, o.type === "stroke" ? o.opacity : o.opacity));
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.type === "text" ? 1 : o.width;
  if (o.type === "stroke") {
    const path = new Path2D(strokeCommands(o.points));
    ctx.stroke(path);
  } else if (o.type === "line" || o.type === "arrow") {
    ctx.beginPath();
    ctx.moveTo(o.x1, o.y1);
    ctx.lineTo(o.x2, o.y2);
    ctx.stroke();
    if (o.type === "arrow") {
      const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
      const len = Math.max(14, o.width * 4);
      ctx.beginPath();
      ctx.moveTo(o.x2, o.y2);
      ctx.lineTo(o.x2 - len * Math.cos(a - 0.42), o.y2 - len * Math.sin(a - 0.42));
      ctx.moveTo(o.x2, o.y2);
      ctx.lineTo(o.x2 - len * Math.cos(a + 0.42), o.y2 - len * Math.sin(a + 0.42));
      ctx.stroke();
    }
  } else if (o.type === "rect") {
    ctx.strokeRect(o.x, o.y, o.w, o.h);
  } else if (o.type === "circle") {
    ctx.beginPath();
    ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.globalAlpha = o.opacity;
    ctx.font = `${o.fontSize}px "Source Sans 3", sans-serif`;
    ctx.fillText(o.text, o.x, o.y);
  }
  ctx.restore();
}

export function objSvg(o: DrawObj) {
  const op = r2(o.opacity);
  if (o.type === "stroke") {
    return `<path d="${strokeCommands(o.points)}" fill="none" stroke="${o.color}" stroke-width="${r2(o.width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"/>`;
  }
  if (o.type === "line") {
    return `<line x1="${r2(o.x1)}" y1="${r2(o.y1)}" x2="${r2(o.x2)}" y2="${r2(o.y2)}" stroke="${o.color}" stroke-width="${r2(o.width)}" stroke-linecap="round" opacity="${op}"/>`;
  }
  if (o.type === "arrow") {
    const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
    const len = Math.max(14, o.width * 4);
    const x3 = o.x2 - len * Math.cos(a - 0.42);
    const y3 = o.y2 - len * Math.sin(a - 0.42);
    const x4 = o.x2 - len * Math.cos(a + 0.42);
    const y4 = o.y2 - len * Math.sin(a + 0.42);
    return `<path d="M ${r2(o.x1)} ${r2(o.y1)} L ${r2(o.x2)} ${r2(o.y2)} M ${r2(o.x2)} ${r2(o.y2)} L ${r2(x3)} ${r2(y3)} M ${r2(o.x2)} ${r2(o.y2)} L ${r2(x4)} ${r2(y4)}" fill="none" stroke="${o.color}" stroke-width="${r2(o.width)}" stroke-linecap="round" opacity="${op}"/>`;
  }
  if (o.type === "rect") {
    return `<rect x="${r2(Math.min(o.x, o.x + o.w))}" y="${r2(Math.min(o.y, o.y + o.h))}" width="${r2(Math.abs(o.w))}" height="${r2(Math.abs(o.h))}" fill="none" stroke="${o.color}" stroke-width="${r2(o.width)}" opacity="${op}"/>`;
  }
  if (o.type === "circle") {
    return `<ellipse cx="${r2(o.x + o.w / 2)}" cy="${r2(o.y + o.h / 2)}" rx="${r2(Math.abs(o.w / 2))}" ry="${r2(Math.abs(o.h / 2))}" fill="none" stroke="${o.color}" stroke-width="${r2(o.width)}" opacity="${op}"/>`;
  }
  const text = o.text
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
  return `<text x="${r2(o.x)}" y="${r2(o.y)}" fill="${o.color}" font-size="${r2(o.fontSize)}" font-family="Source Sans 3, sans-serif" opacity="${op}">${text}</text>`;
}
