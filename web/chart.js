/* ============================================================
 * 繼承系統表 SVG 樹狀圖（自製排版，不依賴任何外部套件）
 * ============================================================ */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const NODE_W = 178, NODE_H = 108, SP_GAP = 40, SIB_GAP = 26, ROW_H = 176, MARGIN = 36, TOP = 128;
const KIND = {
  decedent: { fill: "#FBE3E1", stroke: "#B3261E", label: "被繼承人" },
  heir:     { fill: "#E3F2E6", stroke: "#1E6B34", label: "繼承人" },
  retrans:  { fill: "#FFF4D6", stroke: "#8A6100", label: "再轉繼承" },
  renounced:{ fill: "#FFF0EE", stroke: "#B3261E", label: "拋棄／喪失繼承權", dashed: true, ink: "#9C1F16" },
  excluded: { fill: "#F3F3F3", stroke: "#9A9A9A", label: "不參與繼承", dashed: true, ink: "#666666" },
};

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;           // 一律用 textContent，避免注入
  return e;
}

/* 每個人在圖上的身分、方塊文字與備註 */
function classify(fam, result) {
  const final = finalShares(result);
  const remarks = buildRemarks(fam, result);
  const info = {}, original = {};
  const walk = (res, fromName) => {
    for (const s of res.shares) {
      original[s.id] ??= s.share;
      if (!res.retransfers[s.id] && !info[s.id]) {
        info[s.id] = { kind: "heir", lines: [fromName ? `再轉繼承（自${fromName}）` : s.short, `應繼分 ${final[s.id]}`] };
      }
    }
    for (const [pid, sub] of Object.entries(res.retransfers)) walk(sub, fam.p[pid].name);
  };
  walk(result, null);

  for (const pid of Object.keys(fam.p)) {
    const r = remarks[pid];
    if (pid === result.decedentId) info[pid] = { kind: "decedent", lines: [] };
    else if (r && r.kind === "retrans") info[pid] = { kind: "retrans", lines: [`原應繼分 ${original[pid]}`, r.tag] };
    else if (r && info[pid]) info[pid].lines.splice(1, 0, r.tag);                  // 繼承人但另有備註
    else if (r) info[pid] = { kind: r.kind === "renounced" || r.kind === "lost" ? "renounced" : "excluded", lines: [r.tag] };
    else if (!info[pid]) info[pid] = { kind: "excluded", lines: ["非繼承人"] };
  }
  return { info, final, remarks };
}

/* 世代：以被繼承人為 0，往上為負、往下為正 */
function generations(fam, root) {
  const gen = { [root]: 0 }, q = [root];
  while (q.length) {
    const id = q.shift(), p = fam.p[id], next = [];
    for (const c of fam.children(id)) next.push([c.id, gen[id] + 1]);
    for (const par of fam.parents(id)) next.push([par.id, gen[id] - 1]);
    if (p.spouse && fam.p[p.spouse]) next.push([p.spouse, gen[id]]);
    for (const [nid, g] of next) if (!(nid in gen)) { gen[nid] = g; q.push(nid); }
  }
  for (const id of Object.keys(fam.p)) if (!(id in gen)) gen[id] = 0;   // 與被繼承人無連結者
  return gen;
}

/* 排版：配偶組成一個單位，單位之間形成樹，由下往上計算寬度 */
function layout(fam, did) {
  const gen = generations(fam, did);
  const hasParents = p => !!(p.father && fam.p[p.father]) || !!(p.mother && fam.p[p.mother]);
  const persons = Object.values(fam.p).sort((a, b) => gen[a.id] - gen[b.id] || (a.birth || "").localeCompare(b.birth || ""));
  const unitOf = {}, units = [];

  for (const p of persons) {
    if (unitOf[p.id]) continue;
    let members = [p];
    const s = p.spouse && fam.p[p.spouse];
    if (s && !unitOf[s.id]) {
      let left = p, right = s;                              // 血親在左、姻親在右
      if (s.id === did || (hasParents(s) && !hasParents(p))) [left, right] = [s, p];
      else if (p.id !== did && !hasParents(p) && !hasParents(s) && p.gender === "F" && s.gender === "M") [left, right] = [s, p];
      members = [left, right];
    }
    const u = { members, children: [], parent: null };
    members.forEach(m => (unitOf[m.id] = u));
    units.push(u);
  }
  for (const u of units) {
    const blood = u.members.find(hasParents);
    if (!blood) continue;
    const pu = unitOf[blood.father && fam.p[blood.father] ? blood.father : blood.mother];
    if (pu && pu !== u) { u.parent = pu; pu.children.push(u); }
  }
  const bloodOf = u => u.members.find(hasParents) || u.members[0];
  for (const u of units) u.children.sort((a, b) => (bloodOf(a).birth || "").localeCompare(bloodOf(b).birth || ""));

  const unitW = u => u.members.length * NODE_W + (u.members.length - 1) * SP_GAP;
  const subW = u => (u._w ??= Math.max(unitW(u),
    u.children.reduce((a, c) => a + subW(c), 0) + Math.max(0, u.children.length - 1) * SIB_GAP));
  const anchorOffset = u => (u.members.length === 2 ? NODE_W + SP_GAP / 2 : NODE_W / 2);
  const bloodCenter = u => {                                 // 子女單位中，與上一代相連的那個人的中心
    const b = bloodOf(u), i = u.members.indexOf(b);
    return u.x + i * (NODE_W + SP_GAP) + NODE_W / 2;
  };

  const minGen = Math.min(...Object.values(gen));
  const pos = {};
  const place = (u, x0) => {
    let cx = x0 + (subW(u) - u.children.reduce((a, c) => a + subW(c), 0) - Math.max(0, u.children.length - 1) * SIB_GAP) / 2;
    for (const c of u.children) { place(c, cx); cx += subW(c) + SIB_GAP; }
    let x;
    if (u.children.length) {
      const mid = (bloodCenter(u.children[0]) + bloodCenter(u.children[u.children.length - 1])) / 2;
      x = Math.min(Math.max(mid - anchorOffset(u), x0), x0 + subW(u) - unitW(u));
    } else {
      x = x0 + (subW(u) - unitW(u)) / 2;
    }
    u.x = x;
    u.y = TOP + (gen[u.members[0].id] - minGen) * ROW_H;
    u.members.forEach((m, i) => (pos[m.id] = { x: x + i * (NODE_W + SP_GAP), y: u.y }));
  };
  const roots = units.filter(u => !u.parent);
  let x = MARGIN;
  for (const r of roots) { place(r, x); x += subW(r) + SIB_GAP * 2; }
  const maxGen = Math.max(...Object.values(gen));
  return { units, unitOf, pos, width: x - SIB_GAP * 2 + MARGIN, height: TOP + (maxGen - minGen) * ROW_H + NODE_H + 70 };
}

function drawChart(fam, result, opts = {}) {
  const { info, remarks } = classify(fam, result);
  const L = layout(fam, result.decedentId);
  const W = Math.max(L.width, 1040);

  // 備註編號：依圖上位置由上而下、由左而右
  const marked = Object.keys(remarks).filter(pid => L.pos[pid])
    .sort((a, b) => L.pos[a].y - L.pos[b].y || L.pos[a].x - L.pos[b].x);
  const markOf = Object.fromEntries(marked.map((pid, i) => [pid, i + 1]));
  const NOTE_SIZE = 12.5, NOTE_LH = 21;
  const perLine = Math.floor((W - MARGIN * 2 - 30) / NOTE_SIZE);
  const wrap = t => { const c = [...t], out = []; for (let i = 0; i < c.length; i += perLine) out.push(c.slice(i, i + perLine).join("")); return out; };
  const noteBlocks = marked.map(pid => {
    const p = fam.p[pid];
    return { n: markOf[pid], kind: remarks[pid].kind, lines: wrap(`${p.name}${p.title ? "（" + p.title + "）" : ""}：${remarks[pid].text}${(opts.remarkExtra || {})[pid] || ""}`) };
  });
  const notesH = noteBlocks.length ? 46 + noteBlocks.reduce((a, b) => a + b.lines.length * NOTE_LH + 4, 0) : 0;
  const treeBottom = L.height - 70;
  const H = treeBottom + 30 + notesH + 50;
  const dec = fam.p[result.decedentId];
  const svg = el("svg", { xmlns: SVGNS, viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    "font-family": "'Microsoft JhengHei','PingFang TC','Noto Sans CJK TC','Noto Sans TC',sans-serif" });
  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF" }));

  // 標題
  svg.appendChild(el("text", { x: W / 2, y: 40, "text-anchor": "middle", "font-size": 26, "font-weight": 700, fill: "#1A1A1A" }, "繼承系統表"));
  svg.appendChild(el("text", { x: W / 2, y: 72, "text-anchor": "middle", "font-size": 15, fill: "#333" },
    `被繼承人：${dec.name}（${roc(result.openedOn)}死亡）　繼承順序：${result.order}`));

  if (opts.note) svg.appendChild(el("text", { x: MARGIN, y: 100, "font-size": 13, "font-weight": 700, fill: "#B3261E" }, opts.note));

  // 圖例
  const legendW = k => 30 + [...KIND[k].label].length * 12.5 + 18;
  let lx = W - MARGIN - Object.keys(KIND).reduce((a, k) => a + legendW(k), 0);
  for (const k of Object.keys(KIND)) {
    const g = el("g");
    g.appendChild(el("rect", { x: lx, y: 88, width: 18, height: 14, rx: 3, fill: KIND[k].fill, stroke: KIND[k].stroke,
      "stroke-dasharray": KIND[k].dashed ? "3 2" : "none" }));
    g.appendChild(el("text", { x: lx + 24, y: 100, "font-size": 12, fill: "#444" }, KIND[k].label));
    svg.appendChild(g); lx += legendW(k);
  }

  const lines = el("g", { stroke: "#4A4A4A", "stroke-width": 1.4, fill: "none" });
  svg.appendChild(lines);

  // 婚姻線與親子線
  for (const u of L.units) {
    const [a, b] = u.members;
    let coupleMid = null;
    if (b) {
      const pa = L.pos[a.id], y = pa.y + NODE_H / 2;
      lines.appendChild(el("line", { x1: pa.x + NODE_W, y1: y, x2: pa.x + NODE_W + SP_GAP, y2: y, "stroke-width": 2.4 }));
      lines.appendChild(el("line", { x1: pa.x + NODE_W, y1: y - 4, x2: pa.x + NODE_W + SP_GAP, y2: y - 4, "stroke-width": 1 }));
      coupleMid = { x: pa.x + NODE_W + SP_GAP / 2, y };
    }
    // 依「從哪裡出發」分組子女
    const groups = {};
    for (const c of Object.values(fam.p)) {
      const ps = [c.father, c.mother].filter(pid => pid && u.members.some(m => m.id === pid));
      if (!ps.length || !L.pos[c.id]) continue;
      let src;
      if (ps.length === 2 && coupleMid) src = coupleMid;
      else { const pp = L.pos[ps[0]]; src = { x: pp.x + NODE_W / 2, y: pp.y + NODE_H }; }
      const key = `${src.x},${src.y}`;
      (groups[key] ||= { src, kids: [] }).kids.push(L.pos[c.id]);
    }
    for (const { src, kids } of Object.values(groups)) {
      const busY = kids[0].y - 34;
      const xs = kids.map(k => k.x + NODE_W / 2);
      lines.appendChild(el("line", { x1: src.x, y1: src.y, x2: src.x, y2: busY }));
      lines.appendChild(el("line", { x1: Math.min(src.x, ...xs), y1: busY, x2: Math.max(src.x, ...xs), y2: busY }));
      for (const kx of xs) lines.appendChild(el("line", { x1: kx, y1: busY, x2: kx, y2: kids[0].y }));
    }
    if (coupleMid) svg.appendChild(el("circle", { cx: coupleMid.x, cy: coupleMid.y, r: 3.5, fill: "#4A4A4A" }));
  }

  // 人物方塊
  for (const p of Object.values(fam.p)) {
    const ps = L.pos[p.id]; if (!ps) continue;
    const { kind, lines: extra } = info[p.id], k = KIND[kind];
    const g = el("g");
    if (kind === "decedent") {
      g.appendChild(el("rect", { x: ps.x - 4, y: ps.y - 4, width: NODE_W + 8, height: NODE_H + 8, rx: 12, fill: "none", stroke: k.stroke, "stroke-width": 2 }));
    }
    g.appendChild(el("rect", { x: ps.x, y: ps.y, width: NODE_W, height: NODE_H, rx: 9, fill: k.fill, stroke: k.stroke,
      "stroke-width": kind === "excluded" ? 1.2 : 1.8, "stroke-dasharray": k.dashed ? "5 3" : "none" }));
    if (markOf[p.id]) {                                       // 備註編號
      g.appendChild(el("text", { x: ps.x + NODE_W - 7, y: ps.y + 15, "text-anchor": "end", "font-size": 11.5, "font-weight": 700,
        fill: kind === "renounced" ? "#B3261E" : "#555" }, `※${markOf[p.id]}`));
    }

    const rows = [];
    if (p.title) rows.push({ t: p.title, size: 12, weight: 700 });
    rows.push({ t: p.name, size: 16, weight: 600 });
    if (p.birth) rows.push({ t: `${roc(p.birth)}生`, size: 10.5 });
    if (p.death) rows.push({ t: `${roc(p.death)}歿`, size: 10.5 });
    const plain = kind === "excluded" || kind === "renounced";
    extra.forEach((t, i) => {
      const last = i === extra.length - 1 && !plain;
      rows.push({ t, size: last ? 12.5 : kind === "renounced" ? 11.5 : 10.5, weight: last || kind === "renounced" ? 700 : 400,
        ink: kind === "renounced" || (t.includes("拋棄") || t.includes("喪失")) ? "#9C1F16" : null });
    });
    const lh = r => r.size + 4;
    const total = rows.reduce((a, r) => a + lh(r), 0);
    let ty = ps.y + (NODE_H - total) / 2;
    const color = k.ink && kind === "excluded" ? k.ink : "#1A1A1A";
    for (const r of rows) {
      ty += lh(r);
      const fit = Math.min(r.size, (NODE_W - 12) / Math.max(1, [...r.t].length) * 1.02);   // 太長就縮小字級
      g.appendChild(el("text", { x: ps.x + NODE_W / 2, y: ty - 4, "text-anchor": "middle", "font-size": fit.toFixed(1),
        "font-weight": r.weight || 400, fill: r.ink || (kind === "renounced" ? "#5A2A26" : color) }, r.t));
    }
    svg.appendChild(g);
  }

  // 備註欄
  if (noteBlocks.length) {
    let y = treeBottom + 30;
    svg.appendChild(el("line", { x1: MARGIN, y1: y, x2: W - MARGIN, y2: y, stroke: "#BBBBBB", "stroke-width": 1 }));
    svg.appendChild(el("text", { x: MARGIN, y: y + 28, "font-size": 15, "font-weight": 700, fill: "#1A1A1A" }, "備註"));
    y += 46;
    for (const b of noteBlocks) {
      const ink = b.kind === "renounced" || b.kind === "lost" ? "#9C1F16" : "#333";
      svg.appendChild(el("text", { x: MARGIN, y: y + 14, "font-size": NOTE_SIZE, "font-weight": 700, fill: ink }, `※${b.n}`));
      b.lines.forEach((ln, i) => svg.appendChild(el("text", { x: MARGIN + 34, y: y + 14 + i * NOTE_LH, "font-size": NOTE_SIZE, fill: ink }, ln)));
      y += b.lines.length * NOTE_LH + 4;
    }
  }

  svg.appendChild(el("text", { x: MARGIN, y: H - 22, "font-size": 11, fill: "#777" },
    "本表由離線系統依現行民法自動產生，僅供承辦參考，應與戶籍資料逐一核對後使用。"));
  return svg;
}
