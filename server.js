/* ============================================================
   ОСАДА ЗАМКОВ — игровой сервер.
   Чистый Node.js, БЕЗ npm-зависимостей.
   Связь с клиентами — обычные HTTP-запросы (опрос состояния),
   которые проходят через любой брандмауэр локальной сети.
   Запуск: node server.js   (или двойной клик по «Запустить игру.bat»)
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------- настройки игры ---------------- */
const MW = 256, MH = 256;        // карта: 256 x 256 клеток
const TICK = 100;                // шаг симуляции, мс
const MATCH_TIME = 30 * 60;      // 30 минут на катку

const UNITS = {
  sword:    { name: 'Мечник',      cost: 40,  hp: 60,  dmg: 8,  range: 1.15, aspd: 1.0, spd: 1.15, train: 1.6 },
  archer:   { name: 'Лучник',      cost: 55,  hp: 40,  dmg: 6,  range: 4.0,  aspd: 1.2, spd: 1.0,  train: 2.2 },
  knight:   { name: 'Рыцарь',      cost: 90,  hp: 120, dmg: 14, range: 1.25, aspd: 1.4, spd: 0.85, train: 3.2 },
  builder:  { name: 'Строитель',   cost: 25,  hp: 30,  dmg: 0,  range: 0,    aspd: 1.0, spd: 1.05, train: 1.2 },
  miner:    { name: 'Шахтёр',      cost: 30,  hp: 30,  dmg: 0,  range: 0,    aspd: 1.0, spd: 1.0,  train: 1.2 },
  demolish: { name: 'Демонтажник', cost: 60,  hp: 45,  dmg: 0,  range: 0,    aspd: 1.0, spd: 1.0,  train: 1.6 },
  ram:      { name: 'Таран',       cost: 300, hp: 220, dmg: 0,  range: 1.4,  aspd: 1.0, spd: 0.9,  train: 6.0 }
};
const BUILDS = {
  wall:     { name: 'Стена',  cost: 80,  hp: 200 },
  tower:    { name: 'Башня',  cost: 250, hp: 150, dmg: 10, range: 4.0, aspd: 1.2 },
  barracks: { name: 'Казарма', cost: 350, hp: 150 }
};
const BUILD_WORK = { wall: 20, tower: 45, barracks: 70 }; // «строитель-секунд» на постройку
const DEMOLISH_WORK = { wall: 14, tower: 22, barracks: 28 }; // «демонтажник-секунд»
const CHOP_WORK = 8;       // секунд на одно дерево (одним демонтажником)
const CHOP_GOLD = 10;      // золото за снесённое дерево
const CASTLE_HP  = 1400;
const START_GOLD = 200;
const BASE_INCOME = 1;     // золото в секунду (база)
const MINER_YIELD = 0.25;  // золота/сек за одного шахтёра на обычной шахте
const BIG_YIELD   = 0.5;   // ...на большой шахте (у центра)
const RES_SMALL   = 20 * 60;   // запас обычной шахты: 20 мин при одном шахтёре
const RES_BIG     = 67 * 60;   // запас большой шахты: 67 мин при одном шахтёре
const CAPTURE_TIME = 15;  // секунд на захват рудника
const MAX_QUEUE = 5;
const CASTLE_Y0 = Math.floor(MH / 2) - 2;  // ряды замков: 126..129
const CASTLE_Y1 = CASTLE_Y0 + 4;

/* ---------------- карта ---------------- */
/*
   Процедурная генерация для большой карты 256x256:
   - извилистая река сверху вниз через центр, ширина 4-6;
   - 3-4 моста через реку;
   - ~11 прудов неправильной формы;
   - леса множеством полян (~1/4 карты), тропинки тонкие (1 клетка) через лес;
   - дороги прокладываются только там, где лес/скала реально преграждают путь
     к замкам, мостам и шахтам (по открытой траве юниты идут и так);
   - большие шахты у центра (возле мостов), мелкие — по всей карте;
   - клетки самих замков — скалы (не пройти).
*/
function genMap() {
  // 0 трава, 1 земля/дорога, 2 вода, 3 дерево, 4 скала
  const cells = new Array(MW * MH).fill(0);
  let seed = (Math.random() * 1e9) | 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const get = (x, y) => (x >= 0 && y >= 0 && x < MW && y < MH) ? cells[y * MW + x] : -1;
  const set = (x, y, t) => { if (x >= 0 && y >= 0 && x < MW && y < MH) cells[y * MW + x] = t; };
  const midX = MW >> 1, midY = MH >> 1;

  /* леса: ~60-85 полян радиусом 5.5-12 (~1/4 карты) */
  const groves = [];
  const groveN = 62 + Math.floor(rnd() * 24);
  for (let k = 0; k < groveN; k++) {
    const cx = 10 + Math.floor(rnd() * (MW - 20));
    const cy = 5 + Math.floor(rnd() * (MH - 10));
    const rad = 5.5 + rnd() * 6.5;
    groves.push({ cx, cy, rad });
    const R = Math.ceil(rad);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > rad * rad) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 6 || x > MW - 7 || y < 2 || y > MH - 3) continue;
      if (get(x, y) === 0) set(x, y, 3);
    }
  }
  /* скальные гряды */
  for (let k = 0; k < 55; k++) {
    const cx = 8 + Math.floor(rnd() * (MW - 16));
    const cy = 4 + Math.floor(rnd() * (MH - 8));
    const n = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const x = cx + Math.floor(rnd() * 3) - 1;
      const y = cy + Math.floor(rnd() * 3) - 1;
      if (get(x, y) === 0) set(x, y, 4);
    }
  }

  /* река сверху вниз, ширина 4-6, извилистая, но без резких петляний */
  const riverX = new Array(MH), riverW = new Array(MH);
  let rx = midX - 10 + Math.floor(rnd() * 21), dir = 0, wide = false;
  for (let y = 0; y < MH; y++) {
    if (rnd() < 0.14) dir = dir === 0 ? (rnd() < 0.5 ? -1 : 1) : (rnd() < 0.4 ? 0 : -dir);
    rx = Math.max(midX - 34, Math.min(midX + 34, rx + dir));
    if (rnd() < 0.12) wide = !wide;
    riverX[y] = rx; riverW[y] = wide ? 6 : 4;
    for (let i = 0; i < riverW[y]; i++) set(rx + i, y, 2);
  }

  /* мосты: 3-4 переправы поперёк реки (толщина 3 клетки) */
  const bridgeN = 3 + Math.floor(rnd() * 2);
  const bRows = [];
  for (let k = 0; k < bridgeN; k++) {
    let by = Math.floor(MH * (k + 1) / (bridgeN + 1) - 2 + rnd() * 4);
    by = Math.max(4, Math.min(MH - 8, by));
    if (bRows.some(r => Math.abs(r - by) < 16)) continue;
    bRows.push(by);
  }
  for (const by of bRows) for (let yy = by; yy <= by + 2 && yy < MH; yy++) {
    for (let x = riverX[yy] - 1; x <= riverX[yy] + riverW[yy]; x++) set(x, yy, 1);
  }

  /* пруды: ~11 штук неправильной формы по всей карте */
  const ponds = [];
  for (let k = 0; k < 11; k++) {
    let px = 0, py = 0, ok = false;
    for (let t = 0; t < 25 && !ok; t++) {
      px = 16 + Math.floor(rnd() * (MW - 32));
      py = 10 + Math.floor(rnd() * (MH - 20));
      ok = Math.abs(px - riverX[py]) > 9;
      for (const by of bRows) if (Math.abs(py - by) < 12) ok = false;
      for (const p of ponds) if (Math.hypot(px - p.x, py - p.y) < 24) ok = false;
      if (Math.abs(py - midY) < 14 && (px < 14 || px > MW - 14)) ok = false; // не у замков
    }
    if (!ok) continue;
    ponds.push({ x: px, y: py });
    /* Organic blob: radius varies by angle — coves and "lobes" */
    const baseR = 3.5 + rnd() * 3.5;
    const lobes = 2 + Math.floor(rnd() * 2);
    const ph1 = rnd() * Math.PI * 2, ph2 = rnd() * Math.PI * 2;
    const R = Math.ceil(baseR + 2.3);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const dist = Math.hypot(dx, dy);
      const cx0 = px + dx, cy0 = py + dy;
      if (cx0 < 6 || cx0 > MW - 7 || cy0 < 2 || cy0 > MH - 3) continue;
      if (get(cx0, cy0) === 1) continue; // мосты и дороги не затапливаем
      const ang = Math.atan2(dy, dx);
      const rr = baseR + 1.5 * Math.sin(lobes * ang + ph1) + 0.8 * Math.sin((lobes + 2) * ang + ph2);
      if (dist <= Math.max(2, rr)) set(cx0, cy0, 2);
    }
  }

  /* площадка шахты 3x3 не должна задевать воду (иначе получится брод) */
  const ringClear = (mx, my) => {
    if (my < 1 || my > MH - 2) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = get(mx + dx, my + dy);
      if (t === 2 || t === -1) return false;
    }
    return true;
  };
  /* ближайшее подходящее место для шахты (кольцами) */
  const findSpot = (cx, cy, rad) => {
    for (let r = 0; r <= rad; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 7 || y < 3 || x > MW - 8 || y > MH - 4) continue;
        if (ringClear(x, y)) return [x, y];
      }
    }
    return null;
  };

  /* мелкие шахты — по всей карте */
  const mines = [];
  const smallFrac = [
    [0.16, 0.16], [0.16, 0.84], [0.84, 0.16], [0.84, 0.84],
    [0.50, 0.10], [0.50, 0.90], [0.10, 0.50], [0.90, 0.50],
    [0.30, 0.50], [0.70, 0.50], [0.30, 0.25], [0.70, 0.75]
  ];
  for (const [fx, fy] of smallFrac) {
    let x = Math.round(MW * fx), y = Math.round(MH * fy);
    if (Math.abs(y - midY) < 10 && (x < 14 || x > MW - 14)) y = midY + (y < midY ? -16 : 16);
    const spot = findSpot(x, y, 20);
    if (!spot) continue;
    if (mines.some(m => Math.hypot(m.tx - spot[0], m.ty - spot[1]) < 16)) continue;
    mines.push({ tx: spot[0], ty: spot[1], big: false });
  }

  /* большие шахты — у первой и последней переправы, на разных берегах */
  const b1 = bRows.length ? bRows[0] : Math.floor(MH * 0.25);
  const b2 = bRows.length ? bRows[bRows.length - 1] : Math.floor(MH * 0.75);
  const bank = (row, west) => {
    let edge = west ? riverX[row] : riverX[row] + riverW[row] - 1;
    for (let y = Math.max(0, row - 1); y <= Math.min(MH - 1, row + 1); y++) {
      edge = west ? Math.min(edge, riverX[y]) : Math.max(edge, riverX[y] + riverW[y] - 1);
    }
    return west ? edge - 3 : edge + 3;
  };
  for (const [bx, by] of [[bank(b1, true), b1 + 1], [bank(b2, false), b2 + 1]]) {
    const spot = findSpot(bx, by, 12);
    if (!spot) continue;
    if (mines.some(m => Math.hypot(m.tx - spot[0], m.ty - spot[1]) < 16)) continue;
    mines.push({ tx: spot[0], ty: spot[1], big: true });
  }
  /* площадки шахт 3x3 — чистая земля (лес/скалу убираем, воду не трогаем) */
  for (const m of mines) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = get(m.tx + dx, m.ty + dy);
    if (t === 3 || t === 4) set(m.tx + dx, m.ty + dy, 0);
  }

  /* подступы к замкам всегда чистые */
  for (let y = 0; y < MH; y++) for (const x of [0, 1, 2, 3, MW - 4, MW - 3, MW - 2, MW - 1]) set(x, y, 0);
  /* площадка перед замком — открытая, чтобы юниты строились в строй */
  for (let y = CASTLE_Y0 - 4; y <= CASTLE_Y1 + 3; y++) {
    for (let x = 0; x <= 7; x++) { set(x, y, 0); set(MW - 1 - x, y, 0); }
  }

  /* троппроход: прорубает ТОЛЬКО деревья/скалы на пути 1 клетку шириной;
     вода не трогается — через неё идут мосты */
  const solid = (x, y) => { const t = get(x, y); return t === 3 || t === 4; };
  function fieldOpen(from) {
    const d = new Int32Array(MW * MH).fill(-1);
    const q = new Int32Array(MW * MH);
    let h = 0, t = 0;
    q[t++] = from[1] * MW + from[0];
    d[from[1] * MW + from[0]] = 0;
    while (h < t) {
      const i = q[h++];
      const x = i % MW, y = (i / MW) | 0;
      const dd = d[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        const c = get(nx, ny);
        if (c === 2 || c === -1) continue;
        const j = ny * MW + nx;
        if (d[j] !== -1) continue;
        d[j] = dd + 1;
        q[t++] = j;
      }
    }
    return d;
  }
  function cutPass(a, b) {
    if (get(a[0], a[1]) === 2 || get(b[0], b[1]) === 2) return;
    const d = fieldOpen(a);
    if (d[b[1] * MW + b[0]] < 0) return;
    let cx = b[0], cy = b[1], guard = 0;
    while (!(cx === a[0] && cy === a[1]) && guard++ < 20000) {
      if (solid(cx, cy)) set(cx, cy, 1);
      const here = d[cy * MW + cx];
      let nx = -1, ny = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x2 = cx + dx, y2 = cy + dy;
        const t = get(x2, y2);
        if (t !== 2 && t !== -1 && d[y2 * MW + x2] === here - 1) { nx = x2; ny = y2; break; }
      }
      if (nx < 0) return;
      cx = nx; cy = ny;
    }
    if (solid(cx, cy)) set(cx, cy, 1);
  }

  const aSpawn = [3, midY], bSpawn = [MW - 4, midY];
  /* подступы к мостам и шахтам: чистим только то, что реально мешает пройти */
  for (const by of bRows) {
    cutPass(aSpawn, [riverX[by] - 1, by]);
    cutPass(bSpawn, [riverX[by] + riverW[by], by]);
    for (const yy of [by, by + 1, by + 2]) {
      if (yy >= MH) break;
      if (solid(riverX[yy] - 1, yy)) set(riverX[yy] - 1, yy, 1);
      if (solid(riverX[yy] + riverW[yy], yy)) set(riverX[yy] + riverW[yy], yy, 1);
    }
  }
  for (const m of mines) {
    if (m.big) continue;
    cutPass(m.tx < MW / 2 ? aSpawn : bSpawn, [m.tx, m.ty]);
  }
  for (const m of mines) {
    if (!m.big) continue;
    let by = bRows[0], bd = 1e9;
    for (const r0 of bRows) {
      const dd = Math.abs(m.ty - r0) + Math.abs(m.tx - riverX[r0]);
      if (dd < bd) { bd = dd; by = r0; }
    }
    const near = m.tx < riverX[by] ? [riverX[by] - 1, by] : [riverX[by] + riverW[by], by];
    cutPass([m.tx, m.ty], near);
  }

  /* декоративные тропинки: тонкие (1 клетка) диагонали через случайные поляны,
     прорезают только деревья */
  for (let k = 0; k < 12 && groves.length; k++) {
    const gr = groves[Math.floor(rnd() * groves.length)];
    const ang = rnd() * Math.PI;
    const x0 = Math.max(1, Math.min(MW - 2, Math.round(gr.cx - Math.cos(ang) * (gr.rad + 1))));
    const y0 = Math.max(1, Math.min(MH - 2, Math.round(gr.cy - Math.sin(ang) * (gr.rad + 1))));
    const x1 = Math.max(1, Math.min(MW - 2, Math.round(gr.cx + Math.cos(ang) * (gr.rad + 1))));
    const y1 = Math.max(1, Math.min(MH - 2, Math.round(gr.cy + Math.sin(ang) * (gr.rad + 1))));
    let bx = x0, by = y0;
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    const dxi = Math.abs(x1 - x0), dyi = Math.abs(y1 - y0);
    let e = dxi - dyi, guard = 0;
    while (guard++ < 200) {
      if (get(bx, by) === 3) set(bx, by, 1);
      if (bx === x1 && by === y1) break;
      const e2 = 2 * e;
      if (e2 > -dyi) { e -= dyi; bx += sx; }
      if (e2 < dxi) { e += dxi; by += sy; }
    }
  }

  /* страховка связности: тонкий проруб замка A к замку B (обходит воду,
     прорезает только лес/скалы) */
  cutPass(aSpawn, bSpawn);

  /* клетки замков — скалистая основа (поверх неё рисуется замок) */
  for (let y = CASTLE_Y0; y < CASTLE_Y1; y++) {
    set(0, y, 4); set(1, y, 4); set(MW - 1, y, 4); set(MW - 2, y, 4);
  }

  return { cells, mines };
}

/* ---------------- комнаты ---------------- */
const rooms = new Map();
let roomSeq = 0, pidSeq = 0;

function createRoom() {
  const g = genMap();
  const r = {
    id: 'R' + (++roomSeq),
    phase: 'lobby',              // lobby | countdown | battle | over
    banner: 0,                   // время отсчёта перед боем
    timeLeft: MATCH_TIME,
    cells: g.cells,
    castles: { A: { hp: CASTLE_HP }, B: { hp: CASTLE_HP } },
    units: [],                   // {id, p, type, x, y, hp, cd, order}
    builds: [],                  // {id, p, type, tx, ty, hp, cd}
    sites: [],                   // стройки: {id, p, type, tx, ty, left, total}
    projs: [],
    effects: [],                 // визуальные вспышки {x, y, t}
    chops: new Map(),            // прогресс рубки деревьев: idx клетки -> секунды
    cellChanges: [],             // снесённые деревья: [x, y, тип]
    cellsRev: 0,
    mines: g.mines.map((m, i) => ({ id: 'm' + i, tx: m.tx, ty: m.ty, big: m.big,
                                    owner: null, prog: 0, by: null,
                                    reserve: m.big ? RES_BIG : RES_SMALL,
                                    total: m.big ? RES_BIG : RES_SMALL })),
    queues: { A: [], B: [] },
    gold: { A: START_GOLD, B: START_GOLD },
    income: { A: BASE_INCOME, B: BASE_INCOME },
    players: { A: null, B: null }, // {pid, name, lastSeen}
    fieldA: null, fieldB: null,  // BFS-поля к замкам противника
    formFieldA: null, formFieldB: null, // поля сбора у своих замков
    gridA: null, gridB: null,    // сетки проходимости по командам
    mvCache: new Map(),          // кэш полей для приказов «идти»
    fieldDirty: true,
    winner: null,
    nextId: 1
  };
  rooms.set(r.id, r);
  return r;
}

function sanitizeName(s) {
  s = String(s || '').trim().replace(/[^\wа-яёА-ЯЁ \-]/g, '').slice(0, 16);
  return s || 'Игрок';
}

function joinRoom(name) {
  cleanupRooms();
  let room = null;
  for (const r of rooms.values()) {
    if (r.phase === 'lobby' && (!r.players.A || !r.players.B)) { room = r; break; }
  }
  if (!room) room = createRoom();
  const side = !room.players.A ? 'A' : 'B';
  const pid = 'p' + (++pidSeq) + '_' + Math.random().toString(36).slice(2, 8);
  room.players[side] = { pid, name, lastSeen: Date.now(), cellsRev: room.cellsRev };
  if (room.players.A && room.players.B) { room.phase = 'countdown'; room.banner = 3.0; }
  return { room, side, pid };
}

/* ---------------- проход / поиск пути ---------------- */
function terrainPassable(r, x, y) {
  if (x < 0 || y < 0 || x >= MW || y >= MH) return false;
  const t = r.cells[y * MW + x];
  return t === 0 || t === 1;
}
function buildAt(r, x, y) {
  for (const b of r.builds) if (b.tx === x && b.ty === y) return b;
  return null;
}
function siteAt(r, x, y) {
  for (const s of r.sites) if (s.tx === x && s.ty === y) return s;
  return null;
}
/* сетки проходимости: своя постройка проходима, чужая — нет.
   Строятся один раз на изменение карты/застройки, чтобы BFS был быстрым. */
function rebuildGrids(r) {
  const gA = new Uint8Array(MW * MH), gB = new Uint8Array(MW * MH);
  for (let i = 0; i < MW * MH; i++) {
    const t = r.cells[i];
    const ok = (t === 0 || t === 1) ? 1 : 0;
    gA[i] = ok; gB[i] = ok;
  }
  for (const b of r.builds) {
    const i = b.ty * MW + b.tx;
    if (i >= 0 && i < MW * MH) { if (b.p === 'A') gB[i] = 0; else gA[i] = 0; }
  }
  for (const s of r.sites) {
    const i = s.ty * MW + s.tx;
    if (i >= 0 && i < MW * MH) { if (s.p === 'A') gB[i] = 0; else gA[i] = 0; }
  }
  r.gridA = gA; r.gridB = gB;
}
function gridOf(r, side) {
  // страховка: пересобираем сетку, если изменились здания, стройки или карта
  const stamp = r.builds.length * 7 + r.sites.length * 13 + r.cellsRev * 17;
  if (r.fieldDirty || !r.gridA || stamp !== r.gridStamp) {
    rebuildGrids(r);
    r.gridStamp = stamp;
  }
  return side === 'A' ? r.gridA : r.gridB;
}
function passableFor(r, side, x, y) {
  if (x < 0 || y < 0 || x >= MW || y >= MH) return false;
  return gridOf(r, side)[y * MW + x] === 1;
}
function passable(r, x, y) {
  return terrainPassable(r, x, y) && !buildAt(r, x, y) && !siteAt(r, x, y);
}
/* клетки, которые занимает юнит: таран — 2x2 */
function unitFootCells(u) {
  if (u.type === 'ram') {
    const x0 = Math.floor(u.x), y0 = Math.floor(u.y);
    return [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]];
  }
  return [[Math.floor(u.x), Math.floor(u.y)]];
}
function unitAtCell(r, x, y) {
  for (const u of r.units) {
    for (const [cx, cy] of unitFootCells(u)) if (cx === x && cy === y) return u;
  }
  return null;
}
function isWorker(u) {
  // не дерутся и не ломают чужое: строитель, шахтёр, демонтажник, таран
  return u.type === 'builder' || u.type === 'miner' || u.type === 'demolish' || u.type === 'ram';
}
/* минимальное расстояние от занятых юнитом клеток до точки (центр цели) */
function footDist(u, cx, cy) {
  let d = 1e9;
  for (const [x, y] of unitFootCells(u)) d = Math.min(d, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  return d;
}
/* таран бьёт по зданию, когда его 2x2 упирается в него */
function ramTouches(u, tx, ty) {
  return footDist(u, tx + 0.5, ty + 0.5) <= 1.5;
}
function computeField(r, side, sources) {
  const grid = gridOf(r, side);
  const dist = new Int32Array(MW * MH).fill(-1);
  const q = new Int32Array(MW * MH);
  let head = 0, tail = 0;
  for (const [x, y] of sources) {
    if (x < 0 || y < 0 || x >= MW || y >= MH) continue;
    const i = y * MW + x;
    if (grid[i] !== 1 || dist[i] !== -1) continue;
    dist[i] = 0;
    q[tail++] = i;
  }
  while (head < tail) {
    const i = q[head++];
    const dd = dist[i] + 1;
    if (i >= MW && grid[i - MW] === 1 && dist[i - MW] === -1) { dist[i - MW] = dd; q[tail++] = i - MW; }
    if (i + MW < MW * MH && grid[i + MW] === 1 && dist[i + MW] === -1) { dist[i + MW] = dd; q[tail++] = i + MW; }
    const x = i % MW;
    if (x > 0 && grid[i - 1] === 1 && dist[i - 1] === -1) { dist[i - 1] = dd; q[tail++] = i - 1; }
    if (x < MW - 1 && grid[i + 1] === 1 && dist[i + 1] === -1) { dist[i + 1] = dd; q[tail++] = i + 1; }
  }
  return dist;
}
function ensureFields(r) {
  if (!r.fieldDirty) return;
  r.fieldDirty = false;
  rebuildGrids(r);
  const rows = [CASTLE_Y0, CASTLE_Y0 + 1, CASTLE_Y0 + 2, CASTLE_Y0 + 3];
  r.fieldA = computeField(r, 'A', rows.map(y => [MW - 3, y])); // юниты A идут к замку B
  r.fieldB = computeField(r, 'B', rows.map(y => [2, y]));      // юниты B идут к замку A
  r.formFieldA = null;  // поля сбора считаются по требованию
  r.formFieldB = null;
  r.mvCache.clear();
}
function getFormField(r, side) {
  ensureFields(r);
  if (side === 'A') {
    if (!r.formFieldA) r.formFieldA = computeField(r, 'A', allFormCells(r, 'A'));
    return r.formFieldA;
  }
  if (!r.formFieldB) r.formFieldB = computeField(r, 'B', allFormCells(r, 'B'));
  return r.formFieldB;
}
/* поле до клетки (для приказа «идти»); цель смещается на ближайшую проходимую */
function getMoveField(r, side, tx, ty) {
  ensureFields(r);
  if (!passableFor(r, side, tx, ty)) {
    outer:
    for (let rad = 1; rad <= 4; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.abs(dx) !== rad && Math.abs(dy) !== rad) continue;
          if (passableFor(r, side, tx + dx, ty + dy)) { tx += dx; ty += dy; break outer; }
        }
      }
    }
  }
  const key = side + 'm' + tx + ',' + ty;
  let f = r.mvCache.get(key);
  if (!f) {
    f = computeField(r, side, [[tx, ty]]);
    if (r.mvCache.size > 120) r.mvCache.clear();
    r.mvCache.set(key, f);
  }
  return { field: f, tx, ty };
}
/* поле вокруг постройки/стройки/дерева (для приказов «ломать» / «строить» / «рубить») */
function getAroundField(r, side, tx, ty, tag) {
  ensureFields(r);
  const key = side + tag + tx + '_' + ty;
  let f = r.mvCache.get(key);
  if (!f) {
    const src = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      src.push([tx + dx, ty + dy]);
    }
    f = computeField(r, side, src);
    if (r.mvCache.size > 120) r.mvCache.clear();
    r.mvCache.set(key, f);
  }
  return f;
}
function getBuildField(r, side, cell) {
  return getAroundField(r, side, cell.tx, cell.ty, 'b');
}
function getCellField(r, side, tx, ty) {
  return getAroundField(r, side, tx, ty, 'c');
}
function getMineField(r, side, m) {
  return getAroundField(r, side, m.tx, m.ty, 'm');
}
function inCastleRect(side, x, y) {
  if (y < CASTLE_Y0 || y >= CASTLE_Y1) return false;
  return side === 'A' ? (x >= 0 && x <= 1) : (x >= MW - 2 && x <= MW - 1);
}
/* запретная для стройки зона вокруг замка */
function nearCastleZone(x, y) {
  if (y < CASTLE_Y0 - 2 || y > CASTLE_Y1 + 1) return false;
  return x <= 3 || x >= MW - 4;
}

/* ---------------- бой ---------------- */
function hit(r, target, dmg) {
  target.hp -= dmg;
}
function destroyBuild(r, b) {
  const i = r.builds.indexOf(b);
  if (i >= 0) r.builds.splice(i, 1);
  for (const u of r.units) {
    const o = u.order;
    if (o && (o.k === 'build' || o.k === 'demolish') && o.id === b.id) u.order = null;
  }
  r.effects.push({ x: b.tx + 0.5, y: b.ty + 0.5, t: 0.7 });
  r.fieldDirty = true;
}
function spawnProj(r, x, y, target, dmg, spd, kind, targetKind) {
  const tk = targetKind || 'unit';
  const tx = tk === 'build' ? target.tx + 0.5 : target.x;
  const ty = tk === 'build' ? target.ty + 0.5 : target.y;
  r.projs.push({ x, y, tx, ty, target: target.id, dmg, spd, kind: kind || 'arrow', tk });
}
function nearCastle(r, u, side) {
  const rect = side === 'A'
    ? { x0: 0, y0: CASTLE_Y0, x1: 2, y1: CASTLE_Y1 }
    : { x0: MW - 2, y0: CASTLE_Y0, x1: MW, y1: CASTLE_Y1 };
  const cells = u.type === 'ram' ? unitFootCells(u) : [[u.x, u.y]];
  for (const [px, py] of cells) {
    const cx = Math.min(Math.max(px, rect.x0), rect.x1 - 0.01);
    const cy = Math.min(Math.max(py, rect.y0), rect.y1 - 0.01);
    if (Math.hypot(px - cx, py - cy) <= 1.3) return true;
  }
  return false;
}
function checkWin(r) {
  if (r.phase !== 'battle') return;
  if (r.castles.A.hp <= 0) { r.phase = 'over'; r.winner = 'B'; }
  else if (r.castles.B.hp <= 0) { r.phase = 'over'; r.winner = 'A'; }
}
function endMatch(r) {
  r.phase = 'over';
  const ra = r.castles.A.hp / CASTLE_HP, rb = r.castles.B.hp / CASTLE_HP;
  r.winner = Math.abs(ra - rb) < 0.0001 ? null : (ra > rb ? 'A' : 'B');
}

function moveAlong(r, u, dt, field, dead) {
  if (!field) return false;
  const cx = Math.floor(u.x), cy = Math.floor(u.y);
  const dd = field[cy * MW + cx];
  if (dd < 0) return false;
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let best = null, bd = dd;
  for (const [dx, dy] of dirs) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
    const b = buildAt(r, nx, ny);
    if (b && b.p !== u.p) {
      if (u.type === 'ram') { // таран мгновенно ломает здание и погибает
        destroyBuild(r, b);
        r.effects.push({ x: u.x, y: u.y, t: 0.8 });
        if (dead) dead.add(u);
        return true;
      }
      if (!isWorker(u)) { // вражеская постройка на пути — сносим
        if (u.cd <= 0) {
          b.hp -= UNITS[u.type].dmg;
          u.cd = UNITS[u.type].aspd;
          if (b.hp <= 0) destroyBuild(r, b);
        }
        return true;
      }
      continue; // для рабочего чужая постройка — обходим
    }
    const s = siteAt(r, nx, ny);
    if (s && s.p !== u.p) continue; // чужая стройка непроходима
    const nd = field[ny * MW + nx];
    if (nd >= 0 && nd < bd) { bd = nd; best = [nx, ny]; }
  }
  if (!best) return false;
  const tx = best[0] + 0.5, ty = best[1] + 0.5;
  const dist = Math.hypot(tx - u.x, ty - u.y);
  if (dist < 0.01) return false;
  const step = Math.min(UNITS[u.type].spd * dt, dist);
  u.x += (tx - u.x) / dist * step;
  u.y += (ty - u.y) / dist * step;
  return true;
}

/* расталкивание: юниты не должны толпиться на одной клетке */
function separate(r, dead) {
  const us = r.units;
  for (let i = 0; i < us.length; i++) {
    for (let j = i + 1; j < us.length; j++) {
      const a = us[i], b = us[j];
      if (dead && (dead.has(a) || dead.has(b))) continue;
      const minD = (a.type === 'ram' || b.type === 'ram') ? 1.15 : 0.62;
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= minD) continue;
      if (d < 0.01) { dx = 1; dy = 0; d = 0.01; }
      const push = (minD - d) / 2;
      const ux = dx / d * push, uy = dy / d * push;
      slide(r, a, -ux, -uy);
      slide(r, b, ux, uy);
    }
  }
}
function slide(r, u, dx, dy) {
  const nx = u.x + dx, ny = u.y + dy;
  if (!passableFor(r, u.p, Math.floor(nx), Math.floor(ny))) return;
  u.x = nx; u.y = ny;
}
/* мягко выталкивает юнитов из чужой постройки, чтобы они не застревали */
function pushOutOfEnemyBuilds(r, dt) {
  for (const u of r.units) {
    let bad = null;
    for (const [x, y] of unitFootCells(u)) {
      const b = buildAt(r, x, y) || siteAt(r, x, y);
      if (b && b.p !== u.p) { bad = [x, y]; break; }
    }
    if (!bad) continue;
    const ox = bad[0] + 0.5, oy = bad[1] + 0.5;
    let dx = u.x - ox, dy = u.y - oy;
    let d = Math.hypot(dx, dy);
    if (d < 0.05) { // центр совпал — тянем к ближайшей свободной клетке
      let best = null, bd = 1e9;
      for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
        if (!xx && !yy) continue;
        const nx = bad[0] + xx, ny = bad[1] + yy;
        if (!passableFor(r, u.p, nx, ny)) continue;
        const dd = Math.hypot(nx + 0.5 - u.x, ny + 0.5 - u.y);
        if (dd < bd) { bd = dd; best = [nx + 0.5, ny + 0.5]; }
      }
      if (!best) continue;
      dx = best[0] - u.x; dy = best[1] - u.y; d = Math.hypot(dx, dy) || 1;
    }
    const step = Math.min(d, 1.4 * dt + 0.02);
    u.x += dx / d * step;
    u.y += dy / d * step;
  }
}

function stepRoom(r, dt) {
  if (r.phase === 'countdown') {
    r.banner -= dt;
    if (r.banner <= 0) r.phase = 'battle';
    return;
  }
  if (r.phase !== 'battle') return;

  r.timeLeft -= dt;
  if (r.timeLeft <= 0) { endMatch(r); return; }

  ensureFields(r);

  // доход: база 1/сек + добыча шахтёров у захваченных ещё не истощившихся шахт
  r.income = { A: BASE_INCOME, B: BASE_INCOME };
  for (const m of r.mines) {
    if (!m.owner || m.reserve <= 0) continue;
    let n = 0;
    for (const u of r.units) {
      if (u.p === m.owner && u.type === 'miner' &&
          Math.hypot(u.x - (m.tx + 0.5), u.y - (m.ty + 0.5)) <= 2) n++;
    }
    if (!n) continue;
    const rate = (m.big ? BIG_YIELD : MINER_YIELD) * n;
    r.income[m.owner] += rate;
    m.reserve = Math.max(0, m.reserve - n * dt);
  }
  for (const s of ['A', 'B']) r.gold[s] += r.income[s] * dt;

  // очереди найма: юниты появляются у замка и встают в строй
  for (const s of ['A', 'B']) {
    const q = r.queues[s];
    if (!q.length) continue;
    q[0].t -= dt;
    if (q[0].t <= 0) {
      const type = q[0].type;
      const cell = spawnCell(r, s, type);
      if (cell) {
        const item = q.shift();
        const slot = formCell(r, s, type) || cell;
        r.units.push({
          id: r.nextId++, p: s, type: item.type,
          x: cell[0] + 0.5, y: cell[1] + 0.5,
          hp: UNITS[item.type].hp, cd: 0,
          order: { k: 'form', tx: slot[0], ty: slot[1] }
        });
      } else {
        q[0].t = 0.3; // некуда поставить — попробуем позже
      }
    }
  }

  // захват рудников: 15 секунд рядом; враг рядом — процесс встал; истощённый не захватить
  for (const m of r.mines) {
    if (m.reserve <= 0) { m.prog = 0; m.by = null; continue; }
    let cA = 0, cB = 0;
    for (const u of r.units) {
      if (Math.hypot(u.x - (m.tx + 0.5), u.y - (m.ty + 0.5)) <= 2) {
        if (u.p === 'A') cA++; else cB++;
      }
    }
    if (cA && cB) continue; // спорная — прогресс замирает
    if (cA || cB) {
      const s = cA ? 'A' : 'B';
      if (m.owner !== s) {
        if (m.by !== s) { m.by = s; m.prog = 0; }
        m.prog += dt;
        if (m.prog >= CAPTURE_TIME) {
          m.owner = s; m.prog = 0; m.by = null;
          for (const u of r.units) if (u.order && u.order.k === 'mine' && u.order.id === m.id) u.order = null;
        }
      }
    } else if (m.prog > 0 && m.by) {
      m.prog = Math.max(0, m.prog - dt); // без надсмотрщика прогресс тает
      if (m.prog === 0) m.by = null;
    }
  }

  // стройки: каждый строитель рядом добавляет прогресс, вместе — быстрее
  for (let i = r.sites.length - 1; i >= 0; i--) {
    const s = r.sites[i];
    let n = 0;
    for (const u of r.units) {
      if (u.p === s.p && u.type === 'builder' &&
          Math.hypot(u.x - (s.tx + 0.5), u.y - (s.ty + 0.5)) <= 1.4) n++;
    }
    if (n > 0) s.left -= n * dt;
    if (s.left <= 0) {
      r.sites.splice(i, 1);
      r.builds.push({ id: s.id, p: s.p, type: s.type, tx: s.tx, ty: s.ty, hp: BUILDS[s.type].hp, cd: 0, dp: 0 });
      for (const u of r.units) if (u.order && u.order.k === 'site' && u.order.id === s.id) u.order = null;
      r.fieldDirty = true;
    }
  }

  // снос СВОИХ зданий демонтажниками: возвращается половина стоимости
  for (let i = r.builds.length - 1; i >= 0; i--) {
    const b = r.builds[i];
    let n = 0;
    for (const u of r.units) {
      if (u.type !== 'demolish') continue;
      const o = u.order;
      if (o && o.k === 'demolish' && o.id === b.id && u.p === b.p &&
          Math.hypot(u.x - (b.tx + 0.5), u.y - (b.ty + 0.5)) <= 1.5) n++;
    }
    if (n > 0) b.dp = (b.dp || 0) + n * dt;
    else if (b.dp) b.dp = Math.max(0, b.dp - dt * 0.5);
    if (b.dp >= DEMOLISH_WORK[b.type]) {
      r.gold[b.p] += Math.floor(BUILDS[b.type].cost / 2);
      destroyBuild(r, b);
    }
  }

  // рубка деревьев демонтажниками: +10 золота за дерево
  const chopCount = new Map(), chopSide = new Map();
  for (const u of r.units) {
    if (u.type !== 'demolish') continue;
    const o = u.order;
    if (!o || o.k !== 'chop') continue;
    if (o.tx < 0 || o.ty < 0 || o.tx >= MW || o.ty >= MH) { u.order = null; continue; }
    const idx = o.ty * MW + o.tx;
    if (r.cells[idx] !== 3) { u.order = null; continue; }
    if (Math.hypot(u.x - (o.tx + 0.5), u.y - (o.ty + 0.5)) > 1.5) continue;
    chopCount.set(idx, (chopCount.get(idx) || 0) + 1);
    if (!chopSide.has(idx)) chopSide.set(idx, u.p);
  }
  for (const [idx, n] of chopCount) r.chops.set(idx, (r.chops.get(idx) || 0) + n * dt);
  for (const [idx, prog] of [...r.chops]) {
    if (!chopCount.has(idx)) { // никто не рубит — прогресс медленно тает
      const np = prog - dt * 0.5;
      if (np <= 0) r.chops.delete(idx); else r.chops.set(idx, np);
      continue;
    }
    if (prog >= CHOP_WORK) {
      const tx = idx % MW, ty = (idx / MW) | 0;
      r.cells[idx] = 0;
      r.chops.delete(idx);
      const side = chopSide.get(idx);
      if (side) r.gold[side] += CHOP_GOLD;
      r.cellChanges.push([tx, ty, 0]);
      r.cellsRev++;
      r.fieldDirty = true;
      for (const u of r.units) {
        if (u.order && u.order.k === 'chop' && u.order.tx === tx && u.order.ty === ty) u.order = null;
      }
    }
  }

  const dead = new Set();
  // башни стреляют
  for (const b of r.builds) {
    if (b.type !== 'tower') continue;
    b.cd = (b.cd || 0) - dt;
    if (b.cd > 0) continue;
    const bx = b.tx + 0.5, by = b.ty + 0.5;
    let best = null, bd = BUILDS.tower.range;
    for (const u of r.units) {
      if (u.p === b.p || dead.has(u)) continue;
      const d = Math.hypot(u.x - bx, u.y - by);
      if (d <= bd) { bd = d; best = u; }
    }
    if (best) {
      b.cd = BUILDS.tower.aspd;
      spawnProj(r, bx, by, best, BUILDS.tower.dmg, 7, 'arrow');
    }
  }
  // полёт снарядов: стрелы летят к цели и наносят урон при попадании
  for (let i = r.projs.length - 1; i >= 0; i--) {
    const p = r.projs[i];
    const t = p.tk === 'build'
      ? r.builds.find(x => x.id === p.target)
      : r.units.find(x => x.id === p.target && !dead.has(x));
    if (t) {
      if (p.tk === 'build') { p.tx = t.tx + 0.5; p.ty = t.ty + 0.5; }
      else { p.tx = t.x; p.ty = t.y; }
    }
    const dx = p.tx - p.x, dy = p.ty - p.y;
    const d = Math.hypot(dx, dy);
    const step = (p.spd || 8) * dt;
    if (d <= step || d < 0.05) {
      r.projs.splice(i, 1);
      if (t) {
        if (p.tk === 'build') {
          t.hp -= p.dmg;
          if (t.hp <= 0) destroyBuild(r, t);
        } else {
          hit(r, t, p.dmg);
          if (t.hp <= 0) dead.add(t);
        }
      }
    } else {
      p.x += dx / d * step;
      p.y += dy / d * step;
    }
  }

  // юниты
  const alive = { A: [], B: [] };
  for (const u of r.units) if (!dead.has(u)) alive[u.p].push(u);
  for (const u of r.units) {
    if (dead.has(u)) continue;
    u.cd = Math.max(0, u.cd - dt);
    const def = UNITS[u.type];
    const enemySide = u.p === 'A' ? 'B' : 'A';
    // бойцы сами бьют ближайшего врага в радиусе (лучники — стрелами)
    if (!isWorker(u)) {
      let target = null, td = 1e9;
      for (const f of alive[enemySide]) {
        if (dead.has(f)) continue;
        const d = Math.hypot(f.x - u.x, f.y - u.y);
        if (d <= def.range && d < td) { td = d; target = f; }
      }
      if (target) {
        if (u.cd <= 0) {
          u.cd = def.aspd;
          if (u.type === 'archer') spawnProj(r, u.x, u.y, target, def.dmg, 10, 'arrow');
          else {
            hit(r, target, def.dmg);
            if (target.hp <= 0) dead.add(target);
          }
        }
        continue;
      }
    }
    // приказы
    const o = u.order;
    if (!o) continue; // без приказа юнит стоит на месте
    if (o.k === 'castle') {
      if (u.type === 'ram') {
        if (nearCastle(r, u, enemySide)) {
          // таран отнимает 25% оставшегося ХП замка и погибает
          r.castles[enemySide].hp *= 0.75;
          r.effects.push({ x: u.x, y: u.y, t: 0.8 });
          dead.add(u);
          checkWin(r);
        } else {
          moveAlong(r, u, dt, u.p === 'A' ? r.fieldA : r.fieldB, dead);
        }
        continue;
      }
      if (nearCastle(r, u, enemySide)) {
        if (u.cd <= 0) {
          r.castles[enemySide].hp -= def.dmg;
          u.cd = def.aspd;
          checkWin(r);
        }
      } else {
        moveAlong(r, u, dt, u.p === 'A' ? r.fieldA : r.fieldB, dead);
      }
      continue;
    }
    if (o.k === 'mine') {
      const m = r.mines.find(x => x.id === o.id);
      if (!m || m.owner === u.p || m.reserve <= 0) { u.order = null; continue; }
      const d = Math.hypot(u.x - (m.tx + 0.5), u.y - (m.ty + 0.5));
      if (d <= 1.7) continue; // прибыл — стоит рядом, идёт захват/работа
      // не дошёл по полю (застрял между клеток) — дотягиваем к шахте
      if (!moveAlong(r, u, dt, getMineField(r, u.p, m), dead)) {
        const step = Math.min(UNITS[u.type].spd * dt, d - 1.2);
        if (step > 0) {
          u.x += ((m.tx + 0.5) - u.x) / d * step;
          u.y += ((m.ty + 0.5) - u.y) / d * step;
        }
      }
      continue;
    }
    if (o.k === 'build') {
      const b = r.builds.find(x => x.id === o.id);
      if (!b) { u.order = null; continue; }
      if (u.type === 'ram') {
        if (ramTouches(u, b.tx, b.ty)) { // мгновенно сносит здание и погибает
          destroyBuild(r, b);
          r.effects.push({ x: u.x, y: u.y, t: 0.8 });
          dead.add(u);
        } else {
          moveAlong(r, u, dt, getBuildField(r, u.p, b), dead);
        }
        continue;
      }
      if (isWorker(u)) { u.order = { k: 'move', tx: b.tx, ty: b.ty }; continue; }
      const d = Math.hypot(u.x - (b.tx + 0.5), u.y - (b.ty + 0.5));
      if (d <= def.range) {
        if (u.cd <= 0) {
          u.cd = def.aspd;
          if (u.type === 'archer') {
            spawnProj(r, u.x, u.y, b, def.dmg, 10, 'arrow', 'build');
          } else {
            b.hp -= def.dmg;
            if (b.hp <= 0) destroyBuild(r, b);
          }
        }
      } else {
        moveAlong(r, u, dt, getBuildField(r, u.p, b), dead);
      }
      continue;
    }
    if (o.k === 'demolish') {
      const b = r.builds.find(x => x.id === o.id);
      if (!b || b.p !== u.p || u.type !== 'demolish') { u.order = null; continue; }
      if (Math.hypot(u.x - (b.tx + 0.5), u.y - (b.ty + 0.5)) <= 1.5) continue; // работает
      moveAlong(r, u, dt, getBuildField(r, u.p, b), dead);
      continue;
    }
    if (o.k === 'chop') {
      if (o.tx < 0 || o.ty < 0 || o.tx >= MW || o.ty >= MH || r.cells[o.ty * MW + o.tx] !== 3) {
        u.order = null; continue;
      }
      if (Math.hypot(u.x - (o.tx + 0.5), u.y - (o.ty + 0.5)) <= 1.5) continue; // рубит
      moveAlong(r, u, dt, getCellField(r, u.p, o.tx, o.ty), dead);
      continue;
    }
    if (o.k === 'site') {
      const s = r.sites.find(x => x.id === o.id);
      if (!s) { u.order = null; continue; }
      if (u.type !== 'builder' || s.p !== u.p) { u.order = { k: 'move', tx: s.tx, ty: s.ty }; continue; }
      if (Math.hypot(u.x - (s.tx + 0.5), u.y - (s.ty + 0.5)) <= 1.3) continue; // прибыл — строит
      moveAlong(r, u, dt, getBuildField(r, u.p, s), dead);
      continue;
    }
    if (o.k === 'form') {
      const d = Math.hypot(u.x - (o.tx + 0.5), u.y - (o.ty + 0.5));
      if (d <= 0.4) { u.order = null; continue; }
      const f = getFormField(r, u.p);
      if (!moveAlong(r, u, dt, f, dead) && d <= 1.0) u.order = null;
      continue;
    }
    if (o.k === 'move') {
      const d = Math.hypot(u.x - (o.tx + 0.5), u.y - (o.ty + 0.5));
      if (d <= 0.3) { u.order = null; continue; }
      const mf = getMoveField(r, u.p, o.tx, o.ty);
      if (!moveAlong(r, u, dt, mf.field, dead)) {
        if (d <= 1.0) u.order = null; // упёрся — если цель близко, считаем прибытием
      }
      continue;
    }
    u.order = null;
  }
  for (const u of dead) {
    const i = r.units.indexOf(u);
    if (i >= 0) r.units.splice(i, 1);
  }
  separate(r, dead);
  pushOutOfEnemyBuilds(r, dt);
  // визуальные вспышки
  for (let i = r.effects.length - 1; i >= 0; i--) {
    r.effects[i].t -= dt;
    if (r.effects[i].t <= 0) r.effects.splice(i, 1);
  }
}

/* помещается ли юнит (таран — 2x2) в клетку */
function fitsUnit(r, s, x, y, type) {
  const cells = type === 'ram'
    ? [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]
    : [[x, y]];
  for (const [cx, cy] of cells) {
    if (!passableFor(r, s, cx, cy)) return false;
    if (unitAtCell(r, cx, cy)) return false;
  }
  return true;
}
/* клетка появления у замка / казармы */
function spawnCell(r, s, type) {
  const cand = [];
  for (const b of r.builds) {
    if (b.p === s && b.type === 'barracks') cand.push([s === 'A' ? b.tx + 1 : b.tx - 1, b.ty]);
  }
  const ex = s === 'A' ? 2 : MW - 3;
  for (let y = CASTLE_Y0; y < CASTLE_Y1; y++) {
    cand.push([ex, y]);
    if (type === 'ram') cand.push([s === 'A' ? ex : ex - 1, y]);
  }
  for (const [x, y] of cand) {
    if (fitsUnit(r, s, x, y, type)) return [x, y];
  }
  return null;
}
/* свободная клетка в строю возле своего замка */
function slotBusy(r, x, y, type) {
  if (type === 'ram') {
    if (unitAtCell(r, x, y) || unitAtCell(r, x + 1, y) || unitAtCell(r, x, y + 1) || unitAtCell(r, x + 1, y + 1)) return true;
  } else if (unitAtCell(r, x, y)) return true;
  for (const u of r.units) {
    const o = u.order;
    if (o && (o.k === 'form' || o.k === 'move') && o.tx === x && o.ty === y) return true;
  }
  return false;
}
function formCell(r, s, type) {
  const xs = s === 'A' ? [3, 4, 5, 6] : [MW - 7, MW - 6, MW - 5, MW - 4];
  for (let y = CASTLE_Y0 - 2; y < CASTLE_Y1 + 2; y++) {
    for (const x of xs) {
      if (fitsUnit(r, s, x, y, type) && !slotBusy(r, x, y, type)) return [x, y];
    }
  }
  for (const [x, y] of allFormCells(r, s)) {
    if (fitsUnit(r, s, x, y, type) && !slotBusy(r, x, y, type)) return [x, y];
  }
  return null;
}
function allFormCells(r, s) {
  const xs = s === 'A' ? [3, 4, 5, 6] : [MW - 7, MW - 6, MW - 5, MW - 4];
  const out = [];
  for (let y = CASTLE_Y0 - 3; y < CASTLE_Y1 + 3; y++) for (const x of xs) out.push([x, y]);
  return out;
}

/* ---------------- команды игроков ---------------- */
function applyCmd(r, side, cmd) {
  if (!cmd || typeof cmd !== 'object') return 'нет команды';
  if (r.phase !== 'battle') return 'матч ещё не начался';
  const gold = r.gold[side];
  if (cmd.type === 'build') {
    const def = BUILDS[cmd.build];
    if (!def) return 'неизвестная постройка';
    const tx = cmd.tx | 0, ty = cmd.ty | 0;
    if (!terrainPassable(r, tx, ty)) return 'здесь нельзя строить';
    if (nearCastleZone(tx, ty)) return 'вплотную к замку строить нельзя';
    if (buildAt(r, tx, ty) || siteAt(r, tx, ty)) return 'клетка занята';
    if (unitAtCell(r, tx, ty)) return 'на клетке стоит юнит';
    for (const m of r.mines) if (m.tx === tx && m.ty === ty) return 'здесь рудник';
    if (gold < def.cost) return 'не хватает золота';
    r.gold[side] -= def.cost;
    const work = BUILD_WORK[cmd.build];
    r.sites.push({ id: r.nextId++, p: side, type: cmd.build, tx, ty, left: work, total: work });
    r.fieldDirty = true;
    return null;
  }
  if (cmd.type === 'train') {
    const def = UNITS[cmd.unit];
    if (!def) return 'неизвестный юнит';
    if (r.queues[side].length >= MAX_QUEUE) return 'очередь найма заполнена';
    if (gold < def.cost) return 'не хватает золота';
    r.gold[side] -= def.cost;
    r.queues[side].push({ type: cmd.unit, t: def.train });
    return null;
  }
  if (cmd.type === 'order') {
    // приказ выделенным юнитам: идти / сломать чужое здание / захватить рудник / атаковать замок
    const ids = new Set((cmd.ids || []).map(Number));
    if (!ids.size) return 'никто не выделен';
    const tx = cmd.tx | 0, ty = cmd.ty | 0;
    if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return 'вне карты';
    const mine = r.mines.find(m => m.tx === tx && m.ty === ty);
    const b = buildAt(r, tx, ty);
    const s = siteAt(r, tx, ty);
    const tree = r.cells[ty * MW + tx] === 3;
    const enemyCastle = inCastleRect(side === 'A' ? 'B' : 'A', tx, ty);
    let kind = 'move', arg = null;
    if (mine && mine.owner !== side && mine.reserve > 0) { kind = 'mine'; arg = mine.id; }
    else if (b && b.p !== side) { kind = 'build'; arg = b.id; }
    else if (b && b.p === side) { kind = 'demolish'; arg = b.id; }
    else if (tree) { kind = 'chop'; }
    else if (enemyCastle) { kind = 'castle'; }
    else if (s && s.p === side) { kind = 'site'; arg = s.id; }
    let n = 0;
    for (const u of r.units) {
      if (u.p !== side || !ids.has(u.id)) continue;
      if (kind === 'move') {
        u.order = { k: 'move', tx, ty };
      } else if (kind === 'mine') {
        u.order = { k: 'mine', id: arg };
      } else if (kind === 'build') {
        // чужие здания ломают бойцы и таран; рабочие просто подходят
        if (u.type === 'ram' || !isWorker(u)) u.order = { k: 'build', id: arg };
        else u.order = { k: 'move', tx, ty };
      } else if (kind === 'demolish') {
        // свои здания сносит только демонтажник, остальные идут (своё проходимо)
        if (u.type === 'demolish') u.order = { k: 'demolish', id: arg };
        else u.order = { k: 'move', tx, ty };
      } else if (kind === 'chop') {
        if (u.type === 'demolish') u.order = { k: 'chop', tx, ty };
        else u.order = { k: 'move', tx, ty };
      } else if (kind === 'site') {
        if (u.type === 'builder' && s && s.p === side) u.order = { k: 'site', id: arg };
        else u.order = { k: 'move', tx, ty };
      } else {
        u.order = { k: 'castle' };
      }
      if (++n >= 60) break;
    }
    return n ? null : 'нет ваших юнитов среди выделенных';
  }
  return 'неизвестная команда';
}

/* ---------------- снимок состояния ---------------- */
const r2 = v => Math.round(v * 20) / 20;
function snapshot(r, side) {
  const pl = r.players[side];
  let cellChanges = null;
  if (pl && pl.cellsRev !== r.cellsRev) {
    cellChanges = r.cellChanges;
    pl.cellsRev = r.cellsRev;
  }
  return {
    phase: r.phase,
    you: side,
    winner: r.winner,
    banner: Math.max(0, Math.ceil(r.banner)),
    timeLeft: Math.max(0, Math.floor(r.timeLeft)),
    names: { A: r.players.A ? r.players.A.name : null, B: r.players.B ? r.players.B.name : null },
    gold: { A: Math.floor(r.gold.A), B: Math.floor(r.gold.B) },
    income: { A: Math.round(r.income.A * 100) / 100, B: Math.round(r.income.B * 100) / 100 },
    castles: { A: Math.max(0, Math.round(r.castles.A.hp)), B: Math.max(0, Math.round(r.castles.B.hp)) },
    counts: { A: r.units.filter(u => u.p === 'A').length, B: r.units.filter(u => u.p === 'B').length },
    mines: r.mines.map(m => ({ id: m.id, tx: m.tx, ty: m.ty, owner: m.owner,
                              prog: r2(Math.max(0, m.prog)), by: m.by, big: !!m.big,
                              res: Math.round(100 * m.reserve / m.total) / 100 })),
    units: r.units.map(u => ({ id: u.id, p: u.p, type: u.type, x: r2(u.x), y: r2(u.y), hp: Math.round(u.hp), o: u.order ? u.order.k : null })),
    builds: r.builds.map(b => ({ id: b.id, p: b.p, type: b.type, tx: b.tx, ty: b.ty, hp: Math.round(b.hp),
                                 dp: b.dp ? Math.min(1, b.dp / DEMOLISH_WORK[b.type]) : 0 })),
    sites: r.sites.map(s => ({ id: s.id, p: s.p, type: s.type, tx: s.tx, ty: s.ty, done: r2(Math.max(0, 1 - s.left / s.total)) })),
    projs: r.projs.map(p => ({ x: r2(p.x), y: r2(p.y), tx: r2(p.tx), ty: r2(p.ty), kind: p.kind || 'arrow' })),
    effects: r.effects.map(e => ({ x: r2(e.x), y: r2(e.y), t: r2(e.t) })),
    chops: [...r.chops].map(([idx, prog]) => ({ tx: idx % MW, ty: (idx / MW) | 0, prog: Math.min(1, prog / CHOP_WORK) })),
    cellChanges,
    queues: { A: r.queues.A.map(q => q.type), B: r.queues.B.map(q => q.type) }
  };
}

/* ---------------- обслуживание комнат ---------------- */
function cleanupRooms() {
  const now = Date.now();
  for (const [id, r] of rooms) {
    const stale = s => !s || now - s.lastSeen > 8000;
    if (r.phase === 'lobby') {
      if (stale(r.players.A)) r.players.A = null;
      if (stale(r.players.B)) r.players.B = null;
      if (!r.players.A && !r.players.B) rooms.delete(id);
    } else if (r.phase === 'over') {
      if (stale(r.players.A) && stale(r.players.B)) rooms.delete(id);
      if (now - (r.players.A ? r.players.A.lastSeen : 0) > 10 * 60 * 1000) rooms.delete(id);
    } else {
      if (stale(r.players.A) && stale(r.players.B)) rooms.delete(id);
    }
  }
  // не даём комнатам накопиться
  if (rooms.size > 30) {
    const ids = [...rooms.keys()].slice(0, rooms.size - 30);
    for (const id of ids) {
      const r = rooms.get(id);
      if (r.phase === 'lobby') rooms.delete(id);
    }
  }
}

/* ---------------- HTTP ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }

  /* --- API --- */
  if (u.pathname === '/api/join') {
    const room = joinRoom(sanitizeName(u.searchParams.get('name')));
    sendJson(res, 200, {
      pid: room.pid, side: room.side, room: room.room.id,
      name: room.room.players[room.side].name,
      cells: room.room.cells, mines: room.room.mines
    });
    return;
  }
  if (u.pathname === '/api/state') {
    const r = rooms.get(u.searchParams.get('room'));
    const pid = u.searchParams.get('pid');
    if (!r) return sendJson(res, 404, { error: 'Комната закрыта' });
    const side = (r.players.A && r.players.A.pid === pid) ? 'A'
               : (r.players.B && r.players.B.pid === pid) ? 'B' : null;
    if (!side) return sendJson(res, 404, { error: 'Вы не в комнате' });
    r.players[side].lastSeen = Date.now();
    sendJson(res, 200, snapshot(r, side));
    return;
  }
  if (u.pathname === '/api/cmd') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const r = rooms.get(String(data.room || ''));
        const side = r && r.players.A && r.players.A.pid === data.pid ? 'A'
                   : r && r.players.B && r.players.B.pid === data.pid ? 'B' : null;
        if (!r || !side) return sendJson(res, 404, { error: 'Комната закрыта' });
        r.players[side].lastSeen = Date.now();
        const err = applyCmd(r, side, data.cmd);
        sendJson(res, 200, { ok: !err, error: err });
      } catch (e) {
        sendJson(res, 400, { error: 'Неверный запрос' });
      }
    });
    return;
  }

  /* --- статика --- */
  let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  if (p.includes('..')) { res.writeHead(403); return res.end(); }
  // текстуры лежат в <папка проекта>/assets, отдаём их по пути /assets/...
  if (p.startsWith('/assets/')) {
    const alt = path.join(__dirname, p);
    if (fs.existsSync(alt) && fs.statSync(alt).isFile()) return streamFile(res, alt);
  }
  const file = path.join(PUBLIC_DIR, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  streamFile(res, file);
});

function streamFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const noCache = ['.html', '.css', '.js'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': noCache ? 'no-store' : 'public, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- главный цикл ---------------- */
setInterval(() => {
  for (const r of rooms.values()) stepRoom(r, TICK / 1000);
}, TICK);
setInterval(cleanupRooms, 3000);

server.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(58);
  console.log('');
  console.log(line);
  console.log('   ОСАДА ЗАМКОВ — сервер запущен!');
  console.log(line);
  console.log('  На этом компьютере (хост):');
  console.log('      http://localhost:' + PORT);
  console.log('');
  console.log('  Игрокам в той же сети WiFi откройте в браузере:');
  const nets = os.networkInterfaces();
  let shown = 0;
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family !== 'IPv4' || n.internal) continue;
      console.log('      http://' + n.address + ':' + PORT + '   (' + name + ')');
      shown++;
    }
  }
  if (!shown) console.log('      (локальные адреса не найдены — проверьте WiFi)');
  console.log('');
  console.log('  Двое игроков в комнате — и матч начнётся сам.');
  console.log('  Остановить сервер: нажмите Ctrl+C');
  console.log(line);
  console.log('');
});

/* экспорт для автотестов — на обычный запуск не влияет */
module.exports = {
  server, rooms, createRoom, stepRoom, applyCmd, snapshot, genMap, passableFor,
  UNITS, BUILDS, MW, MH, CASTLE_Y0, CASTLE_Y1, DEMOLISH_WORK, CHOP_WORK, CASTLE_HP, START_GOLD
};
