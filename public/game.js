/* ============================================================
   ОСАДА ЗАМКОВ — клиент.
   Отрисовка на canvas, состояние приходит с сервера по HTTP,
   команды отправляются на сервер. Никакой игровой логики тут нет.
   Камера: + / − — зум, стрелки / зажатый ПКМ — перемещение.
   Юниты: ЛКМ-рамка — выделение, пробел — снять, ЛКМ — приказ.
   ============================================================ */
'use strict';

const T = 36;                 // размер клетки в пикселях (при зуме 1)
const MW = 256, MH = 256;
const ZMIN = 0.4;             // на большой карте нужен широкий обзор
const ZMAX = 2.5;

const UNIT_DEFS = {
  sword:    { name: 'Мечник',      cost: 40,  hot: '1' },
  archer:   { name: 'Лучник',      cost: 55,  hot: '2' },
  knight:   { name: 'Рыцарь',      cost: 90,  hot: '3' },
  builder:  { name: 'Строитель',   cost: 25,  hot: '4' },
  miner:    { name: 'Шахтёр',      cost: 30,  hot: '5' },
  demolish: { name: 'Демонтажник', cost: 60,  hot: '6' },
  ram:      { name: 'Таран',       cost: 300, hot: '7' }
};
const UNIT_HP = { sword: 60, archer: 40, knight: 120, builder: 30, miner: 30, demolish: 45, ram: 220 };
const BUILD_DEFS = {
  wall:     { name: 'Стена',   cost: 80,  hp: 200, hot: 'Q' },
  tower:    { name: 'Башня',   cost: 250, hp: 150, hot: 'W' },
  barracks: { name: 'Казарма', cost: 350, hp: 150, hot: 'E' }
};
const TEAM_COL  = { A: '#3f6fd8', B: '#d84a3f' };
const TEAM_NAME = { A: 'Синие', B: 'Красные' };
const CASTLE_HP = 1400;
const CAPTURE_TIME = 15;
const CASTLE_Y0 = Math.floor(MH / 2) - 2;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const el = id => document.getElementById(id);
const overlay = el('overlay');
const panel = el('panel');

/* ---------- ресурсы ---------- */
const ASSETS = ['tile_grass','tile_dirt','tile_water','tile_tree','tile_rock',
  'wall','tower','barracks','mine','castle_a','castle_b',
  'u_sword','u_archer','u_knight','arrow'];
const IMG = {};
let assetsReady = false;
{
  let n = 0;
  for (const a of ASSETS) {
    const img = new Image();
    const done = () => { if (++n === ASSETS.length) assetsReady = true; };
    img.onload = done;
    img.onerror = () => { console.warn('нет текстуры', a); done(); };
    img.src = 'assets/' + a + '.png';
    IMG[a] = img;
  }
}

/* ---------- состояние клиента ---------- */
let me = null;         // {pid, side, room, name, cells}
let st = null;         // последний снимок состояния сервера
let buildMode = null;  // выбранная постройка для размещения
let lastName = '';
let pollTimer = null;
let failCount = 0;
let mouseCell = null;
let btns = {};
let lastOverlayHTML = '';

/* камера: cam.x/y — мировой пиксель в левом верхнем углу экрана, cam.z — зум */
const cam = { x: 0, y: MH * T - canvas.height, z: 0.75 };
const sel = new Set();          // id выделенных своих юнитов
const fx = [];                  // метки приказов {x,y,t}
const keys = new Set();         // удерживаемые клавиши (стрелки)
let drag = null;                // {mode:'box'|'pan', sx,sy, cx,cy, moved}

/* карта 256x256 рисуется кусками 16x16 клеток, чтобы не держать в памяти
   холст 9216x9216 пикселей */
const CHUNK = 16, CHUNK_PX = CHUNK * T, CHUNK_MAX = 28;
const chunkCache = new Map();
const minimap = document.createElement('canvas');
minimap.width = MW; minimap.height = MH;
let minimapDirty = true;
const MM_SIZE = 168, MM_PAD = 10;
function minimapRect() {
  return { x: canvas.width - MM_SIZE - MM_PAD, y: MM_PAD, w: MM_SIZE, h: MM_SIZE };
}

/* ---------- оверлей ---------- */
function showOverlay(html) {
  if (html === lastOverlayHTML) return;
  lastOverlayHTML = html;
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  lastOverlayHTML = '';
  overlay.classList.add('hidden');
}

/* ---------- меню ---------- */
function showMenu() {
  const def = lastName || ('Игрок ' + (1 + Math.floor(Math.random() * 99)));
  showOverlay(
    '<h1>Осада Замков</h1>' +
    '<p class="big">Фэнтезийная дуэль: защитите свой замок и разнесите вражеский.</p>' +
    '<p>Карта 256×256 · база +1 з/сек · шахтёр у своей шахты: +0.25 з/сек (+0.5 у больших)</p>' +
    '<p>Захват шахты — 15 секунд; запасы истощаются: 20 мин на одного шахтёра (большая — 67 мин)</p>' +
    '<p>ЛКМ-рамка — выделить юнитов · пробел — снять выделение · ЛКМ — приказ.<br>' +
    'Здания строят строители (4): клик по своей половине → стройка → приведите строителей.<br>' +
    'Демонтажник (6) сносит свои здания и рубит деревья, таран (7) 2×2 ломает чужое ценой своей жизни.</p>' +
    '<p>Стрелки / зажатый ПКМ — двигать камеру, «+» / «−» — приблизить / отдалить.</p>' +
    '<input id="nameInp" maxlength="16" placeholder="Ваше имя" value="' + def + '">' +
    '<button id="joinBtn">В БОЙ!</button>' +
    '<p id="connStatus" class="status">Подключение к серверу…</p>'
  );
  el('joinBtn').onclick = () => join(el('nameInp').value);
  el('nameInp').onkeydown = e => { if (e.key === 'Enter') join(el('nameInp').value); };
  el('nameInp').focus();
}

async function join(rawName) {
  const name = (rawName || '').trim().slice(0, 16) || 'Игрок';
  lastName = name;
  const cs = el('connStatus');
  if (cs) { cs.textContent = 'Подключение к серверу…'; cs.className = 'status'; }
  try {
    const r = await fetch('/api/join?name=' + encodeURIComponent(name));
    if (!r.ok) throw new Error('сервер вернул код ' + r.status);
    me = await r.json();
    sel.clear(); fx.length = 0;
    buildTerrain();
    cam.x = me.side === 'A' ? 0 : MW * T - canvas.width / cam.z;
    cam.y = CASTLE_Y0 * T + 2 * T - canvas.height / cam.z / 2;
    clampCam();
    failCount = 0;
    startPolling();
  } catch (e) {
    if (cs) { cs.textContent = 'Не удалось подключиться: ' + e.message; cs.className = 'status err'; }
  }
}

/* ---------- опрос состояния ---------- */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 120);
  poll();
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
async function poll() {
  if (!me) return;
  try {
    const r = await fetch('/api/state?pid=' + encodeURIComponent(me.pid) + '&room=' + encodeURIComponent(me.room));
    if (r.status === 404) {
      stopPolling();
      me = null; st = null;
      showOverlay(
        '<h2>Комната закрыта</h2>' +
        '<p>Сервер перезапускали или матч завершился.</p>' +
        '<button id="againBtn">Вернуться в лобби</button>'
      );
      el('againBtn').onclick = () => { showMenu(); };
      return;
    }
    st = await r.json();
    failCount = 0;
    if (st.cellChanges && st.cellChanges.length) applyCellChanges(st.cellChanges);
    // выделение живёт только пока юнит жив и свой
    for (const id of [...sel]) {
      if (!st.units.some(u => u.id === id && u.p === me.side)) sel.delete(id);
    }
    updateOverlay();
    updateTopbar();
    refreshPanel();
  } catch (e) {
    failCount++;
    if (failCount > 15) {
      stopPolling();
      showOverlay(
        '<h2>Связь потеряна</h2>' +
        '<p>Сервер не отвечает. Проверьте, запущен ли он.</p>' +
        '<button id="againBtn">Переподключиться</button>'
      );
      el('againBtn').onclick = () => { failCount = 0; startPolling(); };
    }
  }
}

function updateOverlay() {
  if (!me || !st) return;
  if (st.phase === 'lobby') {
    const inRoom = (st.names.A ? 1 : 0) + (st.names.B ? 1 : 0);
    showOverlay(
      '<h1>Осада Замков</h1>' +
      '<p class="big">Ждём соперника… ' + inRoom + ' из 2 игроков в комнате</p>' +
      '<p>Вы играете за <b style="color:' + TEAM_COL[me.side] + '">' + TEAM_NAME[me.side] + '</b> (' +
        (me.side === 'A' ? 'замок слева' : 'замок справа') + '), комната ' + me.room + '</p>' +
      '<p>Передайте второму игроку адрес из чёрного окна сервера,<br>например <b>http://192.168.0.5:8080</b></p>' +
      '<p class="status">Связь с сервером установлена — всё работает</p>'
    );
  } else if (st.phase === 'countdown') {
    showOverlay(
      '<h2>' + st.banner + '</h2>' +
      '<p class="big">' + TEAM_NAME.A + ': ' + (st.names.A || '—') + ' &nbsp;·&nbsp; ' +
      TEAM_NAME.B + ': ' + (st.names.B || '—') + '</p>'
    );
  } else if (st.phase === 'over') {
    let msg;
    if (!st.winner) msg = '<h1>Ничья!</h1><p class="big">Оба замка устояли.</p>';
    else if (st.winner === me.side) msg = '<h1>ПОБЕДА!</h1><p class="big">Замок врага пал.</p>';
    else msg = '<h1>Поражение…</h1><p class="big">Ваш замок разрушен.</p>';
    showOverlay(msg + '<button id="rematchBtn">Играть снова</button>');
    el('rematchBtn').onclick = () => { me = null; st = null; sel.clear(); showMenu(); };
  } else {
    hideOverlay();
  }
}

/* ---------- панель управления ---------- */
function buildPanel() {
  panel.innerHTML = '';
  btns = {};
  for (const k of Object.keys(UNIT_DEFS)) {
    const d = UNIT_DEFS[k];
    const b = document.createElement('button');
    b.innerHTML = d.name + ' <small>' + d.cost + ' · [' + d.hot + ']</small>';
    b.onclick = () => { buildMode = null; sendCmd({ type: 'train', unit: k }); refreshPanel(); };
    btns['u_' + k] = b;
    panel.appendChild(b);
  }
  const sep = document.createElement('div');
  sep.className = 'sep';
  panel.appendChild(sep);
  for (const k of Object.keys(BUILD_DEFS)) {
    const d = BUILD_DEFS[k];
    const b = document.createElement('button');
    b.innerHTML = d.name + ' <small>' + d.cost + ' · [' + d.hot + ']</small>';
    b.onclick = () => { buildMode = (buildMode === k) ? null : k; refreshPanel(); };
    btns['b_' + k] = b;
    panel.appendChild(b);
  }
  const hint = document.createElement('div');
  hint.id = 'hint';
  hint.innerHTML = 'Стройка: выбрать постройку, кликнуть ЛКМ — привести строителей (4) к месту. Золото спишется сразу.<br>' +
    'Демонтажник (6): ЛКМ по своему зданию — снести (вернут половину цены), по дереву — срубить (+10).<br>' +
    'Таран (7): 2×2, ЛКМ по чужому зданию — мгновенно снести, по замку — −25% ХП; после удара гибнет.<br>' +
    'Шахты: захват — выделить бойцов и ЛКМ по шахте (15 с), затем шахтёры (5) дают +0.25 з/сек.<br>' +
    'Выделение — ЛКМ-рамка, снять — Пробел/Esc. Мини-карта справа — прыжок камеры.';
  panel.appendChild(hint);
  const q = document.createElement('div');
  q.id = 'queue';
  panel.appendChild(q);
}
function refreshPanel() {
  if (!me || !st) return;
  const gold = st.gold[me.side];
  for (const k of Object.keys(UNIT_DEFS)) btns['u_' + k].classList.toggle('off', gold < UNIT_DEFS[k].cost);
  for (const k of Object.keys(BUILD_DEFS)) {
    const b = btns['b_' + k];
    b.classList.toggle('off', gold < BUILD_DEFS[k].cost);
    b.classList.toggle('armed', buildMode === k);
  }
  const q = st.queues[me.side];
  let txt = q.length ? 'Найм: ' + q.map(t => UNIT_DEFS[t].name).join(' → ') : '';
  if (sel.size) txt += (txt ? ' · ' : '') + 'Выделено: ' + sel.size;
  el('queue').textContent = txt;
}

/* ---------- верхняя панель ---------- */
function updateTopbar() {
  if (!st) return;
  const mm = Math.floor(st.timeLeft / 60), ss = st.timeLeft % 60;
  el('time').textContent = mm + ':' + String(ss).padStart(2, '0');
  if (!me) return;
  el('gold').textContent = st.gold[me.side];
  const inc = (st.income && st.income[me.side] != null) ? st.income[me.side] : 1;
  el('income').textContent = '+' + inc + '/сек';
  el('nameA').textContent = st.names.A || '—';
  el('nameB').textContent = st.names.B || '—';
  el('hpA').style.width = Math.max(0, 100 * st.castles.A / CASTLE_HP) + '%';
  el('hpB').style.width = Math.max(0, 100 * st.castles.B / CASTLE_HP) + '%';
  el('cntA').textContent = st.counts.A + ' юн.';
  el('cntB').textContent = st.counts.B + ' юн.';
}

/* ---------- карта местности (кэш) ---------- */
const TILE_NAMES = ['tile_grass', 'tile_dirt', 'tile_water', 'tile_tree', 'tile_rock'];
const TILE_COL = ['#4c7a3a', '#8a6f4a', '#2f5f9e', '#24502a', '#6b6b6b'];
function buildTerrain() {
  chunkCache.clear();
  minimapDirty = true;
}
function getChunk(cx, cy) {
  const key = cx + ',' + cy;
  let c = chunkCache.get(key);
  if (c) { chunkCache.delete(key); chunkCache.set(key, c); return c; }
  if (chunkCache.size >= CHUNK_MAX) chunkCache.delete(chunkCache.keys().next().value);
  const cv = document.createElement('canvas');
  cv.width = CHUNK_PX; cv.height = CHUNK_PX;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  for (let y = 0; y < CHUNK; y++) {
    for (let x = 0; x < CHUNK; x++) {
      const wx = x0 + x, wy = y0 + y;
      if (wx >= MW || wy >= MH) continue;
      g.drawImage(IMG[TILE_NAMES[me.cells[wy * MW + wx]]], x * T, y * T);
    }
  }
  chunkCache.set(key, cv);
  return cv;
}
function drawTerrain() {
  const vw = canvas.width / cam.z, vh = canvas.height / cam.z;
  const x0 = Math.max(0, Math.floor(cam.x / CHUNK_PX));
  const y0 = Math.max(0, Math.floor(cam.y / CHUNK_PX));
  const x1 = Math.min(Math.ceil(MW / CHUNK) - 1, Math.floor((cam.x + vw) / CHUNK_PX));
  const y1 = Math.min(Math.ceil(MH / CHUNK) - 1, Math.floor((cam.y + vh) / CHUNK_PX));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      ctx.drawImage(getChunk(cx, cy), cx * CHUNK_PX, cy * CHUNK_PX);
    }
  }
}
function renderMinimapBase() {
  const g = minimap.getContext('2d');
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      g.fillStyle = TILE_COL[me.cells[y * MW + x]] || '#000';
      g.fillRect(x, y, 1, 1);
    }
  }
  minimapDirty = false;
}
function applyCellChanges(changes) {
  for (const [x, y, t] of changes) {
    if (x >= 0 && y >= 0 && x < MW && y < MH) me.cells[y * MW + x] = t;
  }
  buildTerrain();
}

/* ---------- камера ---------- */
function clampCam() {
  cam.z = Math.min(ZMAX, Math.max(ZMIN, cam.z));
  const vw = canvas.width / cam.z, vh = canvas.height / cam.z;
  cam.x = Math.min(Math.max(0, cam.x), Math.max(0, MW * T - vw));
  cam.y = Math.min(Math.max(0, cam.y), Math.max(0, MH * T - vh));
}
function zoomAt(sx, sy, factor) {
  const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
  cam.z *= factor;
  cam.z = Math.min(ZMAX, Math.max(ZMIN, cam.z));
  cam.x = wx - sx / cam.z;
  cam.y = wy - sy / cam.z;
  clampCam();
}

/* ---------- отрисовка ---------- */
function mineAt(x, y) {
  if (!st) return null;
  for (const m of st.mines) if (m.tx === x && m.ty === y) return m;
  return null;
}
function buildAtClient(x, y) {
  if (!st) return null;
  for (const b of st.builds) if (b.tx === x && b.ty === y) return b;
  return null;
}
function siteAtClient(x, y) {
  if (!st) return null;
  for (const s of st.sites || []) if (s.tx === x && s.ty === y) return s;
  return null;
}
function canBuildHere(cell) {
  if (!me || !st || !cell) return false;
  const tx = cell.x, ty = cell.y;
  if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return false;
  const t = me.cells[ty * MW + tx];
  if (t !== 0 && t !== 1) return false;              // скала/вода/лес — нельзя
  if ((tx <= 3 || tx >= MW - 4) && ty >= CASTLE_Y0 - 2 && ty <= CASTLE_Y0 + 5) return false;
  if (buildAtClient(tx, ty) || siteAtClient(tx, ty) || mineAt(tx, ty)) return false;
  for (const u of st.units) {
    if (u.type === 'ram') {
      const x0 = Math.floor(u.x), y0 = Math.floor(u.y);
      if (tx >= x0 && tx <= x0 + 1 && ty >= y0 && ty <= y0 + 1) return false;
    } else if (Math.floor(u.x) === tx && Math.floor(u.y) === ty) return false;
  }
  return true;
}
function inView(wx, wy, margin) {
  const vw = canvas.width / cam.z, vh = canvas.height / cam.z;
  const m = margin || 0;
  return wx >= cam.x - m && wx <= cam.x + vw + m && wy >= cam.y - m && wy <= cam.y + vh + m;
}
function hpBar(x, y, w, frac, color) {
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(x - 1, y - 1, w + 2, 5);
  ctx.fillStyle = color || '#5fdd4a';
  ctx.fillRect(x, y, Math.max(0, w * Math.min(1, frac)), 3);
}

function drawMines() {
  for (const m of st.mines) {
    const x = m.tx * T, y = m.ty * T;
    if (!inView(x, y, T * 2)) continue;
    const depleted = m.res <= 0;
    ctx.globalAlpha = depleted ? 0.5 : 1;
    ctx.drawImage(IMG.mine, x, y);
    if (m.big) { // большая шахта — второй камушек-насыпь
      ctx.drawImage(IMG.mine, x - 4, y + 4);
    }
    ctx.globalAlpha = 1;
    if (depleted) {
      ctx.strokeStyle = '#8f8f8f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 8, y + 8); ctx.lineTo(x + T - 8, y + T - 8);
      ctx.moveTo(x + T - 8, y + 8); ctx.lineTo(x + 8, y + T - 8);
      ctx.stroke();
      ctx.lineWidth = 1;
      continue;
    }
    if (m.owner) {
      // флажок цвета владельца (у большой шахты — выше)
      const fx0 = x + T - 11, fy0 = m.big ? y - 3 : y + 2;
      ctx.strokeStyle = '#2b2015';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fx0, fy0 + 14);
      ctx.lineTo(fx0, fy0 - 3);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = TEAM_COL[m.owner];
      ctx.beginPath();
      ctx.moveTo(fx0, fy0 - 3);
      ctx.lineTo(fx0 + (m.big ? 12 : 9), fy0);
      ctx.lineTo(fx0, fy0 + 4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#00000088';
      ctx.stroke();
    }
    // полоса процесса захвата (15 секунд)
    if (!m.owner && m.by && m.prog > 0) {
      hpBar(x + 2, y + T + 3, T - 4, m.prog / CAPTURE_TIME, TEAM_COL[m.by]);
    }
    // остаток запаса шахты
    if (m.res < 1) hpBar(x + 2, y + T + 3, T - 4, m.res, '#ffd97a');
  }
}
function drawMineMarkers() {
  if (buildMode || !st) return;
  for (const m of st.mines) {
    if (m.owner === me.side || m.res <= 0) continue;
    if (!inView(m.tx * T, m.ty * T, T * 2)) continue;
    ctx.strokeStyle = 'rgba(255,217,122,.5)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(m.tx * T + 2, m.ty * T + 2, T - 4, T - 4);
    ctx.setLineDash([]);
  }
}
function drawSites() {
  for (const s of st.sites || []) {
    const x = s.tx * T, y = s.ty * T;
    if (!inView(x, y, T * 2)) continue;
    ctx.globalAlpha = 0.45;
    ctx.drawImage(IMG[s.type], x, y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = s.p === me.side ? '#ffd97a' : 'rgba(255,217,122,.4)';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 1.5, y + 1.5, T - 3, T - 3);
    ctx.setLineDash([]);
    hpBar(x + 4, y + T + 2, T - 8, s.done, '#ffd97a');
  }
}
function drawBuilds() {
  for (const b of st.builds) {
    const x = b.tx * T, y = b.ty * T;
    if (!inView(x, y, T * 2)) continue;
    ctx.drawImage(IMG[b.type], x, y);
    if (b.p === me.side) {
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
    }
    const max = (BUILD_DEFS[b.type] && BUILD_DEFS[b.type].hp) || 200;
    if (b.hp < max) hpBar(x + 4, y - 6, T - 8, b.hp / max, '#e8b53f');
    if (b.dp > 0) hpBar(x + 4, y + T + 2, T - 8, b.dp, '#ff9a3c');
  }
}
function drawCastles() {
  ctx.drawImage(IMG.castle_a, 0, CASTLE_Y0 * T);
  ctx.drawImage(IMG.castle_b, (MW - 2) * T, CASTLE_Y0 * T);
  if (!st) return;
  hpBar(14, CASTLE_Y0 * T - 12, 44, st.castles.A / CASTLE_HP, '#5fdd4a');
  hpBar((MW - 2) * T + 14, CASTLE_Y0 * T - 12, 44, st.castles.B / CASTLE_HP, '#5fdd4a');
}
function drawBuilder(x, y, team) {
  ctx.fillStyle = '#e8c39a';
  ctx.fillRect(x - 2, y - 11, 4, 4);                  // лицо
  ctx.fillStyle = '#4a3a24';
  ctx.fillRect(x - 3, y - 12, 6, 2);                  // шапка
  ctx.fillStyle = TEAM_COL[team];
  ctx.fillRect(x - 4, y - 7, 8, 8);                   // туловище
  ctx.fillStyle = '#00000055';
  ctx.fillRect(x - 4, y + 1, 8, 1);
  ctx.strokeStyle = '#8a6a3a';                         // кирка
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x + 5, y - 2);
  ctx.lineTo(x + 9, y - 10);
  ctx.stroke();
  ctx.strokeStyle = '#cfcfcf';
  ctx.beginPath();
  ctx.moveTo(x + 6.5, y - 9.5);
  ctx.lineTo(x + 11, y - 8);
  ctx.stroke();
  ctx.lineWidth = 1;
}
function drawMiner(x, y, team) {
  ctx.fillStyle = '#e8c39a';
  ctx.fillRect(x - 2, y - 11, 4, 4);                  // лицо
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(x - 3, y - 12, 6, 2);                  // каска
  ctx.fillStyle = '#ffd97a';
  ctx.fillRect(x - 1, y - 13, 2, 1);                  // лампа на каске
  ctx.fillStyle = TEAM_COL[team];
  ctx.fillRect(x - 4, y - 7, 8, 8);                   // туловище
  ctx.fillStyle = '#00000055';
  ctx.fillRect(x - 4, y + 1, 8, 1);
  ctx.strokeStyle = '#8a6a3a';                         // лопата
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 2);
  ctx.lineTo(x - 9, y - 10);
  ctx.stroke();
  ctx.fillStyle = '#cfcfcf';
  ctx.fillRect(x - 11, y - 12, 5, 3);
  ctx.lineWidth = 1;
}
function drawDemolisher(x, y, team) {
  ctx.fillStyle = '#e8c39a';
  ctx.fillRect(x - 2, y - 11, 4, 4);                  // лицо
  ctx.fillStyle = '#8a4a24';
  ctx.fillRect(x - 3, y - 12, 6, 2);                  // каска
  ctx.fillStyle = TEAM_COL[team];
  ctx.fillRect(x - 4, y - 7, 8, 8);                   // туловище
  ctx.fillStyle = '#00000055';
  ctx.fillRect(x - 4, y + 1, 8, 1);
  ctx.strokeStyle = '#6a4a2a';                         // рукоять кувалды
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + 4, y - 1);
  ctx.lineTo(x + 10, y - 9);
  ctx.stroke();
  ctx.fillStyle = '#b8b8b8';                           // боёк
  ctx.fillRect(x + 7, y - 13, 9, 5);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 7, y - 13, 9, 5);
}
function drawRam(x, y, team) {
  const w = 2 * T;
  const left = x - T / 2, top = y - T / 2;
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath();
  ctx.ellipse(x + T / 2, y + T / 2 - 3, w * 0.44, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // колёса
  ctx.fillStyle = '#2b2015';
  for (const [wx, wy] of [[left + 13, top + w - 12], [left + w - 13, top + w - 12],
                          [left + 13, top + 14], [left + w - 13, top + 14]]) {
    ctx.beginPath();
    ctx.arc(wx, wy, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  // корпус
  ctx.fillStyle = '#7a5a34';
  ctx.fillRect(left + 5, top + 9, w - 10, w - 26);
  ctx.strokeStyle = '#3f2d18';
  ctx.lineWidth = 2;
  ctx.strokeRect(left + 5, top + 9, w - 10, w - 26);
  // крыша цвета команды
  ctx.fillStyle = TEAM_COL[team];
  ctx.beginPath();
  ctx.moveTo(left + 2, top + 11);
  ctx.lineTo(left + w / 2, top - 4);
  ctx.lineTo(left + w - 2, top + 11);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#00000066';
  ctx.stroke();
  // бревно-таран
  ctx.fillStyle = '#5a3f22';
  ctx.fillRect(left + w - 7, y - 4, 19, 8);
  ctx.strokeStyle = '#2b2015';
  ctx.strokeRect(left + w - 7, y - 4, 19, 8);
  ctx.fillStyle = '#c9c9c9';
  ctx.fillRect(left + w + 10, y - 6, 5, 12);
  ctx.lineWidth = 1;
}
function drawUnits() {
  for (const u of st.units) {
    const x = u.x * T, y = u.y * T;
    if (!inView(x, y, T * 3)) continue;
    if (u.type === 'ram') {
      if (u.p === me.side && sel.has(u.id)) {
        ctx.strokeStyle = '#ffe27a';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - T / 2 + 2, y - T / 2 + 2, 2 * T - 4, 2 * T - 4);
        ctx.lineWidth = 1;
      }
      drawRam(x, y, u.p);
      const max = UNIT_HP.ram;
      if (u.hp < max) hpBar(x - T / 2 + 8, y - T / 2 - 8, 2 * T - 16, u.hp / max, '#5fdd4a');
      continue;
    }
    // метка команды под юнитом
    ctx.fillStyle = TEAM_COL[u.p];
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.ellipse(x, y + 8, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (u.p === me.side && sel.has(u.id)) {
      ctx.strokeStyle = '#ffe27a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y + 8, 12, 6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (u.type === 'builder') drawBuilder(x, y, u.p);
    else if (u.type === 'miner') drawMiner(x, y, u.p);
    else if (u.type === 'demolish') drawDemolisher(x, y, u.p);
    else ctx.drawImage(IMG['u_' + u.type], x - 11, y - 12, 22, 22);
    const max = UNIT_HP[u.type] || 100;
    if (u.hp < max) hpBar(x - 9, y - 16, 18, u.hp / max, '#5fdd4a');
  }
}
function drawProjs() {
  for (const p of st.projs) {
    const x = p.x * T, y = p.y * T;
    if (!inView(x, y, T * 2)) continue;
    const ang = Math.atan2((p.ty - p.y) * T, (p.tx - p.x) * T);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.drawImage(IMG.arrow, -7, -3, 14, 6);
    ctx.restore();
  }
}
function drawEffects() {
  for (const e of st.effects || []) {
    const x = e.x * T, y = e.y * T;
    if (!inView(x, y, T * 3)) continue;
    const k = Math.max(0, Math.min(1, e.t / 0.8));
    ctx.strokeStyle = 'rgba(255,200,120,' + k.toFixed(2) + ')';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 8 + (1 - k) * 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,120,60,' + (k * 0.8).toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(x, y, 4 + (1 - k) * 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
function drawChops() {
  for (const c of st.chops || []) {
    const x = c.tx * T, y = c.ty * T;
    if (!inView(x, y, T * 2)) continue;
    hpBar(x + 4, y + T + 2, T - 8, c.prog, '#ff9a3c');
  }
}
function drawFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.t -= dt;
    if (f.t <= 0) { fx.splice(i, 1); continue; }
    ctx.strokeStyle = 'rgba(140,255,140,' + Math.min(1, f.t) + ')';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(f.x * T, f.y * T, 10 + (1.2 - f.t) * 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
function drawBuildCursor() {
  if (!buildMode || !mouseCell || !st || st.phase !== 'battle') return;
  const ok = canBuildHere(mouseCell);
  ctx.fillStyle = ok ? 'rgba(120,220,110,.4)' : 'rgba(230,80,70,.4)';
  ctx.fillRect(mouseCell.x * T, mouseCell.y * T, T, T);
  ctx.drawImage(IMG[buildMode], mouseCell.x * T, mouseCell.y * T);
}
function drawSelRect() {
  if (!drag || drag.mode !== 'box') return;
  ctx.strokeStyle = '#7fe07f';
  ctx.fillStyle = 'rgba(127,224,127,.12)';
  const x = Math.min(drag.wx1, drag.wx2), y = Math.min(drag.wy1, drag.wy2);
  const w = Math.abs(drag.wx2 - drag.wx1), h = Math.abs(drag.wy2 - drag.wy1);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
}

function drawMinimap() {
  if (!st || !me) return;
  if (minimapDirty) renderMinimapBase();
  const r = minimapRect();
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.drawImage(minimap, r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  const sx = r.w / (MW * T), sy = r.h / (MH * T);
  for (const m of st.mines) {
    ctx.fillStyle = m.owner ? TEAM_COL[m.owner] : '#ffd97a';
    ctx.fillRect(r.x + (m.tx + 0.5) * T * sx - 1.5, r.y + (m.ty + 0.5) * T * sy - 1.5, 3, 3);
  }
  for (const b of st.builds) {
    ctx.fillStyle = TEAM_COL[b.p];
    ctx.fillRect(r.x + b.tx * T * sx, r.y + b.ty * T * sy, Math.max(2, T * sx), Math.max(2, T * sy));
  }
  for (const u of st.units) {
    ctx.fillStyle = TEAM_COL[u.p];
    const s = u.type === 'ram' ? 3 : 2;
    ctx.fillRect(r.x + u.x * T * sx - s / 2, r.y + u.y * T * sy - s / 2, s, s);
  }
  ctx.fillStyle = TEAM_COL.A;
  ctx.fillRect(r.x + 1, r.y + CASTLE_Y0 * T * sy, 3, 4 * T * sy);
  ctx.fillStyle = TEAM_COL.B;
  ctx.fillRect(r.x + r.w - 4, r.y + CASTLE_Y0 * T * sy, 3, 4 * T * sy);
  ctx.strokeStyle = '#ffe27a';
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + cam.x * sx, r.y + cam.y * sy, canvas.width / cam.z * sx, canvas.height / cam.z * sy);
  ctx.strokeStyle = '#6b5836';
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.lineWidth = 1;
  ctx.restore();
}

let lastFrame = 0;
function renderFrame(ts) {
  requestAnimationFrame(renderFrame);
  const dt = Math.min(0.1, (ts - lastFrame) / 1000 || 0.016);
  lastFrame = ts;
  if (!me || !assetsReady) return;
  // плавное движение камеры стрелками
  const pan = 420 * dt / cam.z;
  if (keys.has('ArrowLeft'))  cam.x -= pan;
  if (keys.has('ArrowRight')) cam.x += pan;
  if (keys.has('ArrowUp'))    cam.y -= pan;
  if (keys.has('ArrowDown'))  cam.y += pan;
  if (keys.size) clampCam();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0a12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.setTransform(cam.z, 0, 0, cam.z, -cam.x * cam.z, -cam.y * cam.z);
  ctx.imageSmoothingEnabled = false;
  drawTerrain();
  if (st) {
    drawMines();
    drawMineMarkers();
    drawSites();
    drawBuilds();
    drawChops();
    drawCastles();
    drawUnits();
    drawProjs();
    drawEffects();
    drawFx(dt);
    drawBuildCursor();
    drawSelRect();
  }
  ctx.restore();
  drawMinimap();
}

/* ---------- ввод ---------- */
function screenPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}
function worldAt(sx, sy) {
  return { x: cam.x + sx / cam.z, y: cam.y + sy / cam.z };
}
function screenToCell(e) {
  const s = screenPos(e), w = worldAt(s.x, s.y);
  return { x: Math.floor(w.x / T), y: Math.floor(w.y / T) };
}

canvas.addEventListener('mousemove', e => {
  mouseCell = screenToCell(e);
  if (!drag) return;
  const s = screenPos(e);
  if (drag.mode === 'pan') {
    cam.x -= (s.x - drag.sx) / cam.z;
    cam.y -= (s.y - drag.sy) / cam.z;
    if (Math.hypot(s.x - drag.osx, s.y - drag.ovy) > 4) drag.moved = true;
    clampCam();
    drag.sx = s.x; drag.sy = s.y;
  } else {
    const w = worldAt(s.x, s.y);
    drag.wx2 = w.x; drag.wy2 = w.y;
    if (Math.hypot(s.x - drag.osx, s.y - drag.ovy) > 4) drag.moved = true;
  }
});
canvas.addEventListener('mouseleave', () => { mouseCell = null; drag = null; });

canvas.addEventListener('mousedown', e => {
  e.preventDefault();
  const s = screenPos(e);
  // клик по мини-карте — прыжок камеры
  if (e.button === 0 && me && st) {
    const r = minimapRect();
    if (s.x >= r.x && s.x <= r.x + r.w && s.y >= r.y && s.y <= r.y + r.h) {
      const wx = (s.x - r.x) / r.w * MW * T;
      const wy = (s.y - r.y) / r.h * MH * T;
      cam.x = wx - canvas.width / cam.z / 2;
      cam.y = wy - canvas.height / cam.z / 2;
      clampCam();
      return;
    }
  }
  if (e.button === 2) {
    drag = { mode: 'pan', sx: s.x, sy: s.y, osx: s.x, ovy: s.y, moved: false };
    return;
  }
  if (e.button !== 0 || !me || !st || st.phase !== 'battle') return;
  if (buildMode) return;           // размещение — по mouseup
  const w = worldAt(s.x, s.y);
  drag = { mode: 'box', osx: s.x, ovy: s.y, wx1: w.x, wy1: w.y, wx2: w.x, wy2: w.y, moved: false };
});

window.addEventListener('mouseup', e => {
  const d = drag;
  drag = null;
  if (e.button === 2) {
    if (d && !d.moved && buildMode) { buildMode = null; refreshPanel(); }
    return;
  }
  if (e.button !== 0 || !me || !st || st.phase !== 'battle') return;
  const cell = screenToCell(e);
  if (buildMode) {
    // размещение постройки по ЛКМ (работает и без начатого drag)
    if (cell.x >= 0 && cell.y >= 0 && cell.x < MW && cell.y < MH && canBuildHere(cell)) {
      sendCmd({ type: 'build', build: buildMode, tx: cell.x, ty: cell.y });
      buildMode = null;
      refreshPanel();
    }
    return;
  }
  if (!d) return;
  if (d.mode === 'box' && d.moved) {
    // выделение рамкой (ЛКМ + перенос мыши)
    const x1 = Math.min(d.wx1, d.wx2), x2 = Math.max(d.wx1, d.wx2);
    const y1 = Math.min(d.wy1, d.wy2), y2 = Math.max(d.wy1, d.wy2);
    if (!e.shiftKey) sel.clear();
    for (const u of st.units) {
      if (u.p !== me.side) continue;
      const px = u.x * T, py = u.y * T;
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) sel.add(u.id);
    }
    refreshPanel();
    return;
  }
  // клик без переноса
  const s2 = screenPos(e);
  const w = worldAt(s2.x, s2.y);
  // одиночный клик по своему юниту — выделить его
  let clicked = null, cd = 1e9;
  for (const u of st.units) {
    if (u.p !== me.side) continue;
    const dd = Math.hypot(u.x - w.x / T, u.y - w.y / T);
    const rad = u.type === 'ram' ? 1.5 : 0.75;
    if (dd < rad && dd < cd) { cd = dd; clicked = u; }
  }
  if (clicked && !sel.size) { sel.clear(); sel.add(clicked.id); refreshPanel(); return; }
  if (sel.size) {
    sendCmd({ type: 'order', ids: [...sel], tx: cell.x, ty: cell.y });
    fx.push({ x: cell.x + 0.5, y: cell.y + 0.5, t: 1.2 });
  }
});

canvas.addEventListener('contextmenu', e => { e.preventDefault(); });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const s = screenPos(e);
  zoomAt(s.x, s.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

window.addEventListener('keydown', e => {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (!me) return;
  if (e.key === ' ') { e.preventDefault(); sel.clear(); refreshPanel(); return; }
  if (e.key === 'Escape') { buildMode = null; sel.clear(); refreshPanel(); return; }
  if (e.key.startsWith('Arrow')) { keys.add(e.key); e.preventDefault(); return; }
  if (e.key === '+' || e.key === '=') { zoomAt(canvas.width / 2, canvas.height / 2, 1.25); return; }
  if (e.key === '-' || e.key === '_') { zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.25); return; }
  const map = { '1': 'sword', '2': 'archer', '3': 'knight', '4': 'builder', '5': 'miner',
                '6': 'demolish', '7': 'ram', 'q': 'wall', 'w': 'tower', 'e': 'barracks' };
  const k = e.key.toLowerCase();
  if (map[k]) {
    if (UNIT_DEFS[map[k]]) sendCmd({ type: 'train', unit: map[k] });
    else buildMode = (buildMode === map[k]) ? null : map[k];
    refreshPanel();
  }
});
window.addEventListener('keyup', e => {
  if (e.key.startsWith('Arrow')) keys.delete(e.key);
});

/* ---------- отправка команд ---------- */
function sendCmd(cmd) {
  if (!me) return;
  fetch('/api/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: me.pid, room: me.room, cmd })
  }).catch(() => {});
}

/* ---------- старт ---------- */
buildPanel();
showMenu();
requestAnimationFrame(renderFrame);
