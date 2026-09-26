/**
 * BFF 水合层（Wave0–5）：登录 → 日报/快照 → 各模块真数据。
 * Wave5：并行拉取 /api/modules/* + restock-suggest + kitchen 端点逐页水合。
 * 失败/mock/无快照时保留原型 mock DOM，并在角标标明离线/演示。
 */

const TOKEN_KEY = 'boss_app_token';
const REV_KEY = 'boss_app_snap_rev';
const STATUS_KEY = 'boss_app_hydrate_status';

let _api401 = false;
let _aiPendingSeq = 0;

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function setToken(t) {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
}

function setRev(rev) {
  if (rev != null && rev !== '') sessionStorage.setItem(REV_KEY, String(rev));
}

function getRev() {
  const v = sessionStorage.getItem(REV_KEY);
  return v ? parseInt(v, 10) : null;
}

function setHydrateStatus(st) {
  sessionStorage.setItem(STATUS_KEY, JSON.stringify(st));
  applyStatusBadge(st);
}

function notifyHydrate(msg) {
  console.warn('[boss-app]', msg);
  if (typeof window.toast === 'function') {
    try {
      window.toast(msg);
    } catch {
      /* toast 不可用时仅控制台 */
    }
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401) {
    // 登录态失效：立即清除 token，主流程会触发重登重试
    sessionStorage.removeItem(TOKEN_KEY);
    _api401 = true;
  }
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function bossLogin() {
  const j = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'boss', device_fp: 'boss-app' }),
  });
  if (j?.token) setToken(j.token);
  return j;
}

function findHomeCard(titlePart) {
  const home = document.getElementById('p-home');
  if (!home) return null;
  for (const card of home.querySelectorAll('.card')) {
    const ttl = card.querySelector('.card-h .ttl');
    if (ttl && ttl.textContent.includes(titlePart)) return card;
  }
  return null;
}

function findCardIn(rootSel, titlePart) {
  const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
  if (!root) return null;
  for (const card of root.querySelectorAll('.card')) {
    const ttl = card.querySelector('.card-h .ttl');
    if (ttl && ttl.textContent.includes(titlePart)) return card;
  }
  return null;
}

function levelColor(level) {
  if (level === 'critical' || level === 'red') return '#E8584A';
  if (level === 'warn' || level === 'yellow') return '#F2B233';
  if (level === 'info' || level === 'blue') return '#87CEEB';
  return '#9B6BBF';
}

function invStatus(qty, safe) {
  if (isNaN(qty) || isNaN(safe) || safe <= 0) return { cls: 'ok', label: '充足', color: '#5BA85B' };
  const ratio = qty / safe;
  if (ratio < 0.35) return { cls: 'danger', label: '告急', color: '#E8584A' };
  if (ratio < 0.75) return { cls: 'warn', label: '偏低', color: '#F2B233' };
  return { cls: 'ok', label: '充足', color: '#5BA85B' };
}

function formatQty(n) {
  if (n == null || isNaN(n)) return '—';
  const v = parseFloat(n);
  if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (Math.abs(v) >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toFixed(3).replace(/\.?0+$/, '');
}

function fmtMoney(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  const abs = Math.abs(n);
  const s = abs >= 1000 ? Math.round(n).toLocaleString('zh-CN') : String(Math.round(n * 100) / 100);
  return `¥${s}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 端点不可用/无快照判定（__err 为 Promise.allSettled 拒绝时的占位） */
function isNoSnap(j) {
  return !j || j.__err != null || j.hint === 'no_snapshot';
}

function arrOf(j, key) {
  return j && Array.isArray(j[key]) ? j[key] : [];
}

/** 简版折线路径（viewBox w×h），用于替换原型 svg.spark 的 d */
function sparkPath(values, w, h, pad) {
  const nums = values.map(Number).filter((v) => !isNaN(v));
  if (nums.length < 2) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = (w - 2 * pad) / (nums.length - 1);
  return nums
    .map((v, i) => `${i ? 'L' : 'M'}${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)}`)
    .join(' ');
}

/* 局部滑删绑定（与 app.js bindSwipe 同逻辑），只作用于水合重建的行，避免全局重复绑定 */
function bindSwipeLocal(row) {
  const cnt = row.querySelector('.swipe-cnt');
  if (!cnt) return;
  let startX = 0;
  let dx = 0;
  let dragging = false;
  function down(x) {
    startX = x;
    dx = 0;
    dragging = true;
  }
  function move(x) {
    if (!dragging) return;
    dx = Math.max(-130, Math.min(0, x - startX));
    cnt.style.transform = `translateX(${dx}px)`;
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    cnt.style.transform = dx < -60 ? 'translateX(-130px)' : '';
  }
  row.addEventListener('touchstart', (e) => down(e.touches[0].clientX));
  row.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      move(t.clientX);
      if (dragging && Math.abs(t.clientX - startX) > 8) e.preventDefault();
    },
    { passive: false },
  );
  row.addEventListener('touchend', up);
  row.addEventListener('mousedown', (e) => {
    down(e.clientX);
    const mv = (ev) => move(ev.clientX);
    const u = () => {
      up();
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', u);
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', u);
  });
}

/** 重建 swipe-row 后：克隆替换旧行（丢弃旧监听器）再局部绑定 */
function rebindSwipe(container) {
  if (!container) return;
  container.querySelectorAll('.swipe-row').forEach((row) => {
    const clone = row.cloneNode(true);
    row.replaceWith(clone);
    bindSwipeLocal(clone);
  });
}

/**
 * KPI 卡写值：只更新数字文本节点，保留 <small> 单位元素。
 * 值自带单位（如 "1,820 只" / "41.2%"）时把单位同步进 small；
 * 卡片单位为 k 且值过大时换算（如 ¥8,640 → ¥8.6k）。
 */
function applyKpiValue(valEl, rawValue, forceUnit) {
  const str = String(rawValue ?? '—');
  const small = valEl.querySelector('small');
  const m = str.match(/^\s*([\s\S]*?[0-9][0-9.,]*)\s*([^\d\s.,].*)?$/);
  const num = m ? m[1] : str;
  const unit = forceUnit != null ? forceUnit : m && m[2] ? m[2] : null;
  let text = num;
  if (small) {
    const curUnit = small.textContent.trim();
    if (unit != null) {
      small.textContent = unit;
    } else if (/^k$/i.test(curUnit)) {
      const v = parseFloat(num.replace(/[^\d.]/g, ''));
      if (!isNaN(v) && v >= 1000) {
        text = num.replace(/[\d.,]+/, (v / 1000).toFixed(1).replace(/\.0$/, ''));
      }
    }
    let tn = null;
    for (const n of valEl.childNodes) {
      if (n.nodeType === 3) {
        tn = n;
        break;
      }
    }
    if (tn) tn.nodeValue = text;
    else valEl.insertBefore(document.createTextNode(text), small);
  } else {
    valEl.textContent = unit ? `${num}${unit}` : num;
  }
}

function ensureDataBadge() {
  let el = document.getElementById('bossDataBadge');
  if (el) return el;
  const bar = document.querySelector('.statusbar');
  if (!bar) return null;
  el = document.createElement('span');
  el.id = 'bossDataBadge';
  el.className = 'data-badge mock';
  el.textContent = '连接中';
  bar.appendChild(el);
  return el;
}

function applyStatusBadge(st) {
  const el = ensureDataBadge();
  if (!el) return;
  if (!st || st.offline) {
    el.className = 'data-badge offline';
    el.textContent = '离线 | 原型';
    return;
  }
  if (st.mock || !st.snapOk) {
    el.className = 'data-badge mock';
    el.textContent = st.mock ? `mock | rev ${st.rev ?? '—'}` : `无快照 | 原型`;
    return;
  }
  el.className = 'data-badge live';
  el.textContent = `真数据 | rev ${st.rev ?? '—'}`;
}

function markModuleHead(pageId, live, hint) {
  const page = document.getElementById(pageId);
  if (!page) return;
  let badge = page.querySelector('.mod-data-badge');
  if (!badge) {
    const head = page.querySelector('.mod-head') || page.querySelector('.sec-ttl');
    if (!head) return;
    badge = document.createElement('span');
    badge.className = 'mod-data-badge';
    head.appendChild(badge);
  }
  badge.className = 'mod-data-badge ' + (live ? 'live' : 'mock');
  badge.textContent = live ? hint || 'BFF' : hint || '演示';
}

function emptyStateHtml(msg) {
  return `<div class="empty-hint">${esc(msg)}</div>`;
}

/* ---------------- Wave0/1: 日报 ---------------- */

function applyDailyReport(report) {
  if (!report || !report.ok) return false;

  const banner = document.querySelector('#p-home .sum-banner');
  if (banner && report.banner) {
    const lab = banner.querySelector('.sb-lab');
    const val = banner.querySelector('.sb-val');
    const delta = banner.querySelector('.sb-delta');
    if (lab) lab.textContent = String(report.banner);
    if (val && Array.isArray(report.kpi) && report.kpi[0]) {
      const k0 = report.kpi[0];
      const k1 = report.kpi[1];
      val.innerHTML = `${esc(k0.value)} <small>| ${esc(k1?.value || '')} 单 | rev ${esc(report.rev)}</small>`;
    }
    if (delta) {
      delta.textContent = report.mock
        ? '演示数据：云端暂无有效店内流水'
        : `快照同步 | ${report.generated_at ? new Date(report.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}`;
      delta.className = report.mock ? 'sb-delta' : 'sb-delta up';
    }
  }

  const kpiCard = findHomeCard('核心 KPI');
  if (kpiCard && Array.isArray(report.kpi)) {
    // 标题语义白名单：只允许语义匹配的指标覆盖对应卡片，
    // 防止 kpi 后段（原料SKU/会员数/快照rev/销售记录总数）盖掉 翻台率/坪效/人效/桌位 卡
    const KPI_CARD_MAP = {
      今日已售: { labels: ['订单数'], unit: '单' },
      实时毛利: { labels: ['毛利', '毛利率', '实时毛利'], unit: null },
      客单价: { labels: ['客单价'], unit: null },
      实收: { labels: ['营收', '实收'], unit: null },
    };
    kpiCard.querySelectorAll('.kpi .b').forEach((b) => {
      const lab = b.querySelector('.lab');
      const cardName = lab ? lab.textContent.trim() : '';
      const cfg = KPI_CARD_MAP[cardName];
      if (!cfg) return;
      const k = report.kpi.find((x) => x && cfg.labels.includes(String(x.label || '').trim()));
      if (!k) return;
      const val = b.querySelector('.val');
      const dlt = b.querySelector('.delta');
      if (val) applyKpiValue(val, k.value, cfg.unit);
      if (dlt) {
        dlt.textContent = k.delta != null ? String(k.delta) : report.mock ? 'mock' : '—';
        dlt.className = 'delta';
      }
    });
  }

  if (Array.isArray(report.heat_mini) && report.heat_mini.length && typeof window.renderHeat === 'function') {
    const el = document.getElementById('homeHeat');
    if (el) {
      window.renderHeat(el, 2, 12);
      const max = Math.max(...report.heat_mini.map((h) => h.orders || 0), 1);
      const cells = el.querySelectorAll('.heat-cell');
      report.heat_mini.forEach((h) => {
        const hour = h.hour;
        if (hour == null) return;
        const col = hour >= 6 && hour <= 17 ? hour - 6 : null;
        if (col == null || col < 0 || col >= 12) return;
        const row = hour >= 11 && hour <= 14 ? 0 : 1;
        // .heat-cell 选择器不含行首 label，下标为 row*12+col
        const idx = row * 12 + col;
        const cell = cells[idx];
        if (!cell) return;
        const lv = Math.min(4, Math.round(((h.orders || 0) / max) * 4));
        const palette = ['#EEF1F5', '#FBD3CC', '#F48FB1', '#C2185B', '#C2185B'];
        cell.style.background = palette[lv];
        cell.dataset.lv = String(lv);
      });
    }
  }

  const todoCard = findHomeCard('今日待办');
  if (todoCard && Array.isArray(report.todos) && report.todos.length) {
    const todoWrap = todoCard.querySelector('.todo');
    const more = todoCard.querySelector('.more');
    if (more) more.textContent = `${report.todos.length} 项 ›`;
    if (todoWrap) {
      todoWrap.innerHTML = report.todos
        .slice(0, 5)
        .map((t) => {
          const text = t.text || t.title || '';
          const kind = /补货|库存/.test(text)
            ? 'restock'
            : /结算|审批/.test(text)
              ? 'settle'
              : /证|健康|留样/.test(text)
                ? 'foodsafe'
                : 'confirm';
          const actionType =
            kind === 'restock'
              ? 'restock.create'
              : kind === 'settle'
                ? 'settlement.approve'
                : 'boss.confirm';
          const safeText = String(text).replace(/\\/g, '').replace(/'/g, '').slice(0, 80);
          return (
            '<div class="swipe-row"><div class="swipe-act">' +
            `<button class="act-btn act-yes" onclick="bossConfirmAction('${actionType}',{from:'todo',text:'${safeText}'},'已确认')">确认</button>` +
            `<button class="act-btn act-no" onclick="this.closest('.swipe-row').remove();toast('已忽略')">删除</button>` +
            '</div><div class="swipe-cnt"><div class="titem" style="border:none">' +
            '<div class="ic" style="background:#E3EDF7"><svg viewBox="0 0 24 24" fill="none" stroke="#3A6EA5" stroke-width="2">' +
            '<path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
            `<div class="info"><div class="ti">${esc(String(text).slice(0, 48))}</div><div class="ds">${t.done ? '已完成 | ' : ''}BFF 日报</div></div>` +
            `<button class="pbtn" onclick="openSheet('confirm')">${t.done ? '查看' : '确认'}</button>` +
            '</div></div></div>'
          );
        })
        .join('');
      rebindSwipe(todoWrap);
    }
  }

  const alertCard = findHomeCard('预警中心');
  if (alertCard && Array.isArray(report.alerts) && report.alerts.length) {
    alertCard.querySelectorAll('.alert').forEach((n) => n.remove());
    report.alerts.slice(0, 8).forEach((a) => {
      const text = a.text || a.title || '';
      const target = alertTarget(text);
      const div = document.createElement('div');
      div.className = 'alert';
      div.style.cursor = 'pointer';
      div.onclick = () => jumpAlert(target);
      div.innerHTML =
        `<div class="st" style="background:${levelColor(a.level)}"></div>` +
        `<div class="ct"><div class="t2">${esc(String(text).slice(0, 48))}</div>` +
        `<div class="d2">${report.mock ? 'mock 报表' : 'rev ' + (report.rev ?? '—')} | 点此跳转</div></div>`;
      alertCard.appendChild(div);
    });
  }

  const fresh = document.querySelector('#p-home .fresh');
  if (fresh) {
    if (report.generated_at) {
      const t = new Date(report.generated_at);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      fresh.innerHTML = `<i class="dot"></i>${report.mock ? 'mock' : '真'} ${hh}:${mm} | rev ${esc(report.rev ?? '—')}`;
      fresh.classList.toggle('is-mock', !!report.mock);
    } else {
      fresh.innerHTML = `<i class="dot"></i>${report.mock ? '演示 mock' : '已同步'}`;
    }
  }

  if (report.rev != null) setRev(report.rev);
  return true;
}

function alertTarget(text) {
  if (/库存|补货|原料|告急/.test(text)) return { type: 'tab', id: 'inventory' };
  if (/健康证|证照|留样|食安/.test(text)) return { type: 'module', id: 'foodsafe' };
  if (/工单|厨房|品控/.test(text)) return { type: 'tab', id: 'kitchen' };
  if (/预订|排队/.test(text)) return { type: 'module', id: 'booking' };
  if (/温度|冷柜|设备/.test(text)) return { type: 'module', id: 'equipment' };
  if (/价|供应商|比价/.test(text)) return { type: 'module', id: 'supply' };
  return { type: 'tab', id: 'home' };
}

function jumpAlert(target) {
  if (!target) return;
  if (target.type === 'module' && typeof window.goModule === 'function') window.goModule(target.id);
  else if (typeof window.go === 'function') window.go(target.id);
}

/* ---------------- Wave1: 进销 + 首页预订/门店 ---------------- */

function applyHomeBookingAndStatus(snap) {
  const ext = snap.ext && typeof snap.ext === 'object' ? snap.ext : {};
  const bookings = Array.isArray(ext.bookings) ? ext.bookings : [];
  const queue = Array.isArray(ext.queue) ? ext.queue : [];
  const today = todayStr();
  const bkToday = bookings.filter((b) => String(b.date || '').startsWith(today));
  const people = bkToday.reduce((s, b) => s + (parseInt(b.party_size, 10) || 0), 0);
  const waiting = queue.filter((q) => !/已入座|完成|取消/.test(String(q.status || '')));

  const bookCard = findHomeCard('预订 / 排队');
  if (bookCard) {
    const kvs = bookCard.querySelectorAll('.kv b');
    if (bkToday.length && kvs[0]) {
      kvs[0].textContent = `${bkToday.length} 桌 / ${people} 人`;
      if (kvs[1]) kvs[1].textContent = `等位 ${waiting.length} 桌 | 叫号 ${waiting[0]?.queue_no || '—'}`;
      markModuleHead('p-home', true, '');
      bookCard.dataset.live = '1';
    } else {
      bookCard.querySelectorAll('.kv').forEach((kv, i) => {
        if (i === 0) {
          const b = kv.querySelector('b');
          if (b && !bookCard.dataset.live) b.insertAdjacentHTML('beforeend', ' <small class="mock-tag">演示</small>');
        }
      });
    }
  }

  const kitchen = snap._reportKitchen;
  const stCard = findHomeCard('门店状态');
  if (stCard && kitchen) {
    const total = kitchen.workorders_total || 0;
    const done = kitchen.workorders_done || 0;
    const pct = total ? Math.round((done / total) * 100) : null;
    const ringC = stCard.querySelector('.st-cell .ring .c');
    if (ringC && pct != null) ringC.textContent = `${pct}%`;
  }

  return { bkToday, queue: waiting };
}

function applyInventory(snap) {
  const data = snap.data || {};
  const ings = Array.isArray(data.ings) ? data.ings : [];
  markModuleHead('p-inventory', ings.length > 0, ings.length ? 'BFF' : '演示');

  let listCard = null;
  document.querySelectorAll('#inv-stock .card').forEach((c) => {
    if (c.querySelector('.ttl')?.textContent?.includes('原料库存')) listCard = c;
  });
  if (listCard && ings.length) {
    listCard.querySelectorAll('.inv-row').forEach((r) => r.remove());
    listCard.querySelectorAll('.empty-hint').forEach((r) => r.remove());
    ings.slice(0, 16).forEach((it) => {
      const name = it.name || it.sku || it.sku_id || '原料';
      const qty = parseFloat(it.qty != null ? it.qty : it.stock != null ? it.stock : it.amount);
      const safe = parseFloat(it.safe != null ? it.safe : it.safety != null ? it.safety : it.safe_stock);
      const st = invStatus(qty, safe);
      const pct = !isNaN(qty) && !isNaN(safe) && safe > 0 ? Math.min(100, Math.round((qty / safe) * 100)) : 50;
      const row = document.createElement('div');
      row.className = 'inv-row';
      row.innerHTML =
        `<div class="nm"><div class="n">${esc(name)}</div><div class="d">安全 ${formatQty(safe)} | ${esc(it.unit || '')}</div></div>` +
        `<div class="inv-bar"><div class="top"><b>${formatQty(qty)}</b>/${formatQty(safe)}</div>` +
        `<div class="inv-track"><i style="width:${pct}%;background:${st.color}"></i></div></div>` +
        `<span class="tag ${st.cls}">${st.label}</span>`;
      listCard.appendChild(row);
    });
    const more = listCard.querySelector('.card-h .more');
    if (more) more.textContent = `${ings.length} 种`;

    let ok = 0;
    let warn = 0;
    let danger = 0;
    ings.forEach((it) => {
      const qty = parseFloat(it.qty != null ? it.qty : it.stock);
      const safe = parseFloat(it.safe != null ? it.safe : it.safety);
      const st = invStatus(qty, safe);
      if (st.cls === 'danger') danger += 1;
      else if (st.cls === 'warn') warn += 1;
      else ok += 1;
    });
    const donutLeg = document.querySelector('#inv-stock .card .donut-leg');
    if (donutLeg) {
      const lis = donutLeg.querySelectorAll('.li span:last-child');
      if (lis[0]) lis[0].textContent = `${ok} 项`;
      if (lis[1]) lis[1].textContent = `${warn} 项`;
      if (lis[2]) lis[2].textContent = `${danger} 项`;
    }
    const hole = document.querySelector('#inv-stock .donut .pct');
    if (hole) hole.textContent = `${ings.length}`;
    const holeLb = document.querySelector('#inv-stock .donut .lb');
    if (holeLb) holeLb.textContent = 'SKU';
  }

  // 本地安全线补货建议（restock-suggest 端点失败/无快照时的回退）
  renderRestockLocal(snap, ings);

  const po = Array.isArray(data.orders) ? data.orders : Array.isArray(data.po) ? data.po : [];
  const poPage = document.querySelector('#inv-po');
  if (poPage) {
    const poCard = poPage.querySelector('.card');
    if (poCard) {
      poCard.querySelectorAll('.swipe-row, .empty-hint').forEach((r) => r.remove());
      if (po.length) {
        po.slice(0, 8).forEach((p) => {
          const no = p.no || p.id || 'PO';
          const vendor = p.vendor || p.supplier || '';
          const status = p.status || '草稿';
          const amtRaw = p.amount != null ? p.amount : p.total != null ? p.total : p.payable;
          const amt = amtRaw != null ? `¥${amtRaw}` : '';
          const wrap = document.createElement('div');
          wrap.className = 'swipe-row';
          wrap.innerHTML =
            `<div class="swipe-act"><button class="act-btn act-yes" onclick='bossConfirmAction("order.confirm",${JSON.stringify({
              id: no,
            })},"确认采购单")'>确认</button>` +
            `<button class="act-btn act-no" onclick="this.closest('.swipe-row').remove();toast('已忽略')">删除</button></div>` +
            '<div class="swipe-cnt"><div class="po-row" style="border:none">' +
            `<div style="flex:1"><div class="no">${esc(no)}</div><div class="dt">${esc(vendor)} | ${esc(status)}</div></div>` +
            `<span class="tag warn">${esc(status)}</span><div class="am">${esc(amt)}</div></div></div>`;
          poCard.appendChild(wrap);
        });
        rebindSwipe(poCard);
      } else {
        poCard.insertAdjacentHTML('beforeend', emptyStateHtml('暂无采购单（店内 orders 为空）'));
      }
    }
  }

  const recv = Array.isArray(data.recv) ? data.recv : [];
  const recvPage = document.querySelector('#inv-recv');
  if (recvPage) {
    let recvCard = null;
    recvPage.querySelectorAll('.card').forEach((c) => {
      if (c.querySelector('.ttl')?.textContent?.includes('进货')) recvCard = c;
    });
    if (recvCard) {
      recvCard.querySelectorAll('.po-row, .empty-hint').forEach((r) => r.remove());
      if (recv.length) {
        recv.slice(0, 8).forEach((r) => {
          const id = r.no || r.id || 'JH';
          const vendor = r.supplier || r.vendor || '';
          const lines = Array.isArray(r.lines) ? r.lines.map((l) => l.name || l.ing).filter(Boolean).join('+') : r.note || '';
          const st = r.status || '待收货';
          const row = document.createElement('div');
          row.className = 'po-row';
          row.innerHTML =
            `<div style="flex:1"><div class="no">${esc(id)}${vendor ? ' | ' + esc(vendor) : ''}</div>` +
            `<div class="dt">${esc(String(lines).slice(0, 40))}</div></div>` +
            `<span class="tag ${String(st).includes('已') ? 'ok' : 'warn'}">${esc(st)}</span>`;
          recvCard.appendChild(row);
        });
      } else {
        recvCard.insertAdjacentHTML('beforeend', emptyStateHtml('暂无进货单（店内 recv 为空）'));
      }
    }
  }
}

/** 本地安全线补货建议（回退算法）：restock-suggest 端点可用时会被 applyRestockSuggest 覆盖 */
function renderRestockLocal(snap, ings) {
  const low = ings.filter((it) => {
    const qty = parseFloat(it.qty != null ? it.qty : it.stock);
    const safe = parseFloat(it.safe != null ? it.safe : it.safety);
    return !isNaN(qty) && !isNaN(safe) && qty < safe;
  });
  const restockCard = document.querySelector('#inv-restock .card');
  if (!restockCard) return;
  const title = restockCard.querySelector('.card-h .ttl');
  restockCard.querySelectorAll('.rs-row, .empty-hint').forEach((r) => r.remove());
  if (low.length) {
    if (title) title.textContent = `补货建议（${Math.min(low.length, 8)}条）`;
    low.slice(0, 8).forEach((it) => {
      const name = String(it.name || it.sku || '原料').replace(/'/g, '');
      const qty = parseFloat(it.qty != null ? it.qty : it.stock);
      const safe = parseFloat(it.safe != null ? it.safe : it.safety);
      const need = Math.max(0, safe - qty);
      const avg = parseFloat(it.avg);
      const amt = !isNaN(avg) ? `¥${(avg * need).toFixed(0)}` : '—';
      const row = document.createElement('div');
      row.className = 'rs-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(name)} | 补 ${formatQty(need)}</div>` +
        `<div class="ds">rev ${esc(snap.rev)} | 现 ${formatQty(qty)} / 安全 ${formatQty(safe)} | 本地安全线</div>` +
        `<span class="ai-badge">本地</span></div>` +
        `<div><div class="amt">${amt}</div>` +
        `<button class="pbtn" style="margin-top:6px" onclick='bossConfirmAction("restock.create",${JSON.stringify({
          items: [{ name, qty: need, unit: it.unit || '' }],
          rev: snap.rev,
        })},"确认转单")'>转单</button></div>`;
      restockCard.appendChild(row);
    });
  } else {
    if (title) title.textContent = '补货建议';
    restockCard.insertAdjacentHTML('beforeend', emptyStateHtml('当前无低于安全线的原料'));
  }
}

/** restock-suggest 端点真数据：覆盖本地安全线建议；失败/无快照回 false 保留本地结果 */
function applyRestockSuggest(j) {
  if (!j || j.__err || !j.ok || j.mock) return false;
  const restockCard = document.querySelector('#inv-restock .card');
  if (!restockCard) return false;
  const items = Array.isArray(j.items) ? j.items : [];
  const title = restockCard.querySelector('.card-h .ttl');
  restockCard.querySelectorAll('.rs-row, .empty-hint').forEach((r) => r.remove());
  if (!items.length) {
    if (title) title.textContent = '补货建议';
    restockCard.insertAdjacentHTML('beforeend', emptyStateHtml('当前无告急/偏低原料（BFF 实时）'));
    return true;
  }
  if (title) title.textContent = `补货建议（${items.length}条）`;
  const more = restockCard.querySelector('.card-h .more');
  if (more) more.textContent = j.total != null ? `共 ${j.total} 条 ›` : '全部 ›';
  items.slice(0, 10).forEach((it) => {
    const name = String(it.name || it.ingredientId || '原料').replace(/'/g, '');
    const urg = it.urgency === 'critical' ? '告急' : it.urgency === 'low' ? '偏低' : 'AI 建议';
    const row = document.createElement('div');
    row.className = 'rs-row';
    row.innerHTML =
      `<div class="info"><div class="ti">${esc(name)} · 补 ${formatQty(it.suggestQty)}${esc(it.unit || '')}</div>` +
      `<div class="ds">${esc(it.reason || '')}${it.daysLeft != null ? ` | 约可撑 ${esc(it.daysLeft)} 天` : ''}</div>` +
      `<span class="ai-badge">${urg}</span></div>` +
      `<div><div class="amt">${it.safe != null ? `安全 ${formatQty(it.safe)}` : '—'}</div>` +
      `<button class="pbtn" style="margin-top:6px" onclick='bossConfirmAction("restock.create",${JSON.stringify({
        items: [{ name, qty: it.suggestQty, unit: it.unit || '' }],
        rev: getRev(),
      })},"确认转单")'>转单</button></div>`;
    restockCard.appendChild(row);
  });
  return true;
}

/* ---------------- Wave2: 厨房（菜单真源 = 金丰御字牌五福饺子 docx） ---------------- */

let _wufuMenu = null;

async function loadWufuMenu() {
  if (_wufuMenu) return _wufuMenu;
  try {
    const res = await fetch('/menu-wufu.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('menu http ' + res.status);
    _wufuMenu = await res.json();
  } catch (e) {
    console.warn('[boss-app] load menu-wufu.json failed', e);
    _wufuMenu = null;
  }
  return _wufuMenu;
}

/** 聚合今日五福 SKU 销量：sales 记录匹配 jiao5 菜单项；无真实销量返回 null */
function aggregateWufuSales(snap, menu) {
  const sales = snap && snap.data && Array.isArray(snap.data.sales) ? snap.data.sales : null;
  if (!sales || !sales.length || !menu || !Array.isArray(menu.items)) return null;
  const five = menu.items.filter((i) => i.cat === 'jiao5');
  if (!five.length) return null;
  const today = todayStr();
  const dayOf = (r) => String(r.date || r.ts || r.time || r.created_at || '');
  const dated = sales.filter((r) => dayOf(r).startsWith(today));
  const undated = sales.filter((r) => !dayOf(r));
  // 有日期记录但无今日记录 → 今日无销量；全部无日期 → 全部计入
  if (!dated.length && !undated.length) return null;
  const pool = [...dated, ...undated];
  const byColor = {};
  five.forEach((i) => {
    byColor[i.color] = 0;
  });
  let hit = 0;
  pool.forEach((r) => {
    const name = String(r.name || r.dish || r.title || r.sku || r.sku_id || '');
    if (!name) return;
    const item = five.find(
      (i) =>
        (i.sku_id && (r.sku_id === i.sku_id || r.sku === i.sku_id)) ||
        (i.name && (name.includes(i.name) || i.name.includes(name))) ||
        (i.color && name.includes(i.color) && /饺/.test(name)),
    );
    if (!item) return;
    const q = parseFloat(r.qty ?? r.count ?? r.num ?? 1);
    byColor[item.color] = (byColor[item.color] || 0) + (isNaN(q) ? 1 : q);
    hit += 1;
  });
  return hit ? byColor : null;
}

function renderWufuKitchenMenu(menu, wufuSales) {
  const recList = document.querySelector('#kt-rec .card');
  if (!recList || !menu?.items?.length) return false;

  const items = menu.items;
  const n5 = items.filter((i) => i.cat === 'jiao5').length;
  const nWhite = items.filter((i) => i.cat === 'jiao_white').length;
  const nJian = items.filter((i) => i.cat === 'jian').length;
  const nZheng = items.filter((i) => i.cat === 'zheng').length;
  const total = items.length;

  const more = recList.querySelector('.card-h .more');
  if (more) more.textContent = `${total} 道`;
  const ttl = recList.querySelector('.card-h .ttl');
  if (ttl) ttl.innerHTML = `<i class="em"></i>${esc(menu.brand || '御字牌五福饺子')}`;

  const cat = recList.querySelector('#menucat');
  if (cat) {
    cat.innerHTML =
      `<div class="mc on" data-f="all">全部 ${total}</div>` +
      `<div class="mc" data-f="jiao5">五色饺子 ${n5}</div>` +
      `<div class="mc" data-f="jiao_white">本色白饺 ${nWhite}</div>` +
      `<div class="mc" data-f="jian">冰花煎饺 ${nJian}</div>` +
      `<div class="mc" data-f="zheng">蒸饺 ${nZheng}</div>`;
    cat.querySelectorAll('.mc').forEach((el) => {
      el.onclick = () => {
        cat.querySelectorAll('.mc').forEach((x) => x.classList.remove('on'));
        el.classList.add('on');
        const f = el.getAttribute('data-f');
        recList.querySelectorAll('.rec-row').forEach((row) => {
          row.style.display = f === 'all' || row.getAttribute('data-cat') === f ? '' : 'none';
        });
      };
    });
  }

  recList.querySelectorAll('.rec-row').forEach((r) => r.remove());
  items.forEach((d) => {
    const cls = d.color_css || '';
    const row = document.createElement('div');
    row.className = 'rec-row';
    row.setAttribute('data-cat', d.cat || 'jiao5');
    row.onclick = () => {
      window.__wufuRecipe = d;
      if (typeof window.openSheet === 'function') window.openSheet('recipe', d);
    };
    const tags = (d.tags || []).map((tg) => `<span>${esc(tg)}</span>`).join('');
    row.innerHTML =
      `<div class="rec-dot ${cls}">${esc(d.color || '饺')}</div>` +
      `<div class="rec-info"><div class="nm">${esc(d.name)}</div>` +
      `<div class="ds">${esc(d.subtitle || d.filling || '')}</div>` +
      (tags ? `<div class="rec-tags">${tags}</div>` : '') +
      `</div>` +
      `<div class="rec-cost"><div class="v">—</div><div class="l">成本/份</div></div>`;
    recList.appendChild(row);
  });

  // 首页五福销量：有真实 sales 聚合则渲染真数，否则隐藏卡片不留假数字
  document.querySelectorAll('#p-home .card').forEach((card) => {
    const t = card.querySelector('.card-h .ttl');
    if (!t || !t.textContent.includes('五福销量')) return;
    const box = card.querySelector('.five');
    const five = items.filter((i) => i.cat === 'jiao5');
    if (!box || !five.length) return;
    const hasReal = wufuSales && five.some((d) => (wufuSales[d.color] || 0) > 0);
    if (!hasReal) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    t.innerHTML = '<i class="em"></i>五福销量 · 今日';
    box.innerHTML = '';
    const grads = {
      红: 'linear-gradient(90deg,#FFB6B0,#E8584A)',
      黄: 'linear-gradient(90deg,#FFE08A,#F2B233)',
      绿: 'linear-gradient(90deg,#A8DCA8,#5BA85B)',
      紫: 'linear-gradient(90deg,#D4B8E8,#9B6BBF)',
      黑: 'linear-gradient(90deg,#9aa,#3a3a3a)',
    };
    const max = Math.max(...five.map((d) => wufuSales[d.color] || 0), 1);
    five.forEach((d) => {
      const c = d.color;
      const qty = Math.round(wufuSales[c] || 0);
      const fillShort = String(d.filling || '').replace(/馅$/, '');
      const row = document.createElement('div');
      row.className = 'frow';
      row.innerHTML =
        `<div class="dot5 ${d.color_css}">${esc(c)}</div>` +
        `<div class="fbar"><div class="top"><b>${esc(d.blessing || c)} | ${esc(fillShort)}</b>` +
        `<span class="c">${qty}份</span></div>` +
        `<div class="track"><i style="width:${Math.max(4, Math.round((qty / max) * 100))}%;background:${grads[c] || '#ccc'}"></i></div></div>`;
      box.appendChild(row);
    });
  });

  return true;
}

function applyKitchen(snap) {
  const ext = (snap && snap.ext) || {};
  const wos = Array.isArray(ext.sop_workorders) ? ext.sop_workorders : [];
  const qcs = Array.isArray(ext.qc_records) ? ext.qc_records : [];
  const recipes = Array.isArray(ext.recipes) ? ext.recipes : [];
  if (recipes.length) {
    window.__bffRecipes = recipes;
  }
  markModuleHead('p-kitchen', wos.length + qcs.length + recipes.length > 0, wos.length + qcs.length + recipes.length ? 'BFF' : '演示');

  loadWufuMenu().then((menu) => {
    if (menu) renderWufuKitchenMenu(menu, aggregateWufuSales(snap, menu));
  });

  const sopCard = document.querySelector('#kt-sop .card');
  if (sopCard) {
    const ttl = sopCard.querySelector('.card-h .ttl');
    const tag = sopCard.querySelector('.card-h .tag');
    if (wos.length) {
      const w = wos[0];
      if (ttl) ttl.textContent = `${w.sku_id || '工单'} | ${w.qty || ''} 份`;
      if (tag) {
        tag.textContent = w.status || '进行中';
        tag.className = 'tag ' + (String(w.status).includes('完成') ? 'ok' : 'warn');
      }
      const note = sopCard.querySelector('.timeline');
      if (note && !note.querySelector('.tl-step.bff-wo')) {
        note.insertAdjacentHTML(
          'afterbegin',
          `<div class="tl-step now bff-wo"><div class="tl-time">${esc(String(w.planned_start || '').slice(11, 16) || '—')}</div>` +
            `<div class="tl-ti">快照工单 ${esc(w.id)}</div><div class="tl-ds">状态 ${esc(w.status)} | qty ${esc(w.qty)}</div>` +
            `<span class="tl-qc" style="background:#E3EDF7;color:#3A6EA5">BFF</span></div>`,
        );
      }
    }
  }

  const boardCard = findCardIn('#kt-board', '今日出品');
  if (boardCard) {
    const fresh = boardCard.querySelector('.fresh');
    if (fresh) fresh.innerHTML = `<i class="dot"></i>rev ${esc(snap?.rev)}`;
  }

  const qcPage = document.querySelector('#kt-qc');
  if (qcPage) {
    let statCard = null;
    qcPage.querySelectorAll('.card').forEach((c) => {
      if (c.querySelector('.ttl')?.textContent?.includes('抽查') || c.querySelector('.ttl')?.textContent?.includes('品控')) {
        statCard = c;
      }
    });
    if (statCard) {
      const badge = statCard.querySelector('.badge, .fresh');
      if (badge) badge.textContent = qcs.length ? `${qcs.length} 条` : '0 条';
      if (!qcs.length) {
        let hint = statCard.querySelector('.empty-hint');
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'empty-hint';
          statCard.appendChild(hint);
        }
        hint.textContent = '暂无品控记录 | 可用下方拍照走 Kimi';
      }
    }
  }
}

/* ---------------- Wave3: 预订/食安/排班/分析（快照直取） ---------------- */

function applyBookingModule(snap) {
  const ext = snap.ext || {};
  const bookings = Array.isArray(ext.bookings) ? ext.bookings : [];
  const queue = Array.isArray(ext.queue) ? ext.queue : [];
  const today = todayStr();
  const bkToday = bookings.filter((b) => String(b.date || '').startsWith(today));
  const people = bkToday.reduce((s, b) => s + (parseInt(b.party_size, 10) || 0), 0);
  const live = bkToday.length > 0 || queue.length > 0;
  markModuleHead('p-m-booking', live, live ? 'BFF' : '演示');

  const banner = document.querySelector('#bk-today .sum-banner');
  if (banner && bkToday.length) {
    banner.querySelector('.sb-val').textContent = `${bkToday.length} 桌 / ${people} 人`;
    const confirmed = bkToday.filter((b) => /确认|已/.test(String(b.status || ''))).length;
    banner.querySelector('.sb-delta').textContent = `已确认 ${confirmed} | 待确认 ${bkToday.length - confirmed}`;
  }

  const listCard = findCardIn('#bk-today', '预订清单');
  if (listCard && bkToday.length) {
    listCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    bkToday.slice(0, 8).forEach((b) => {
      const row = document.createElement('div');
      row.className = 'rc-row';
      const st = b.status || '待确认';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(b.time || '')} | ${esc(b.guest_name || '')} ${esc(b.party_size || '')} 人</div>` +
        `<div class="ds">电话 ${esc(b.phone || '')} | ${esc(b.table_id || '')}</div></div>` +
        `<span class="tag ${/确认|已/.test(st) ? 'ok' : 'warn'}">${esc(st)}</span>`;
      listCard.appendChild(row);
    });
  }

  const qBanner = document.querySelector('#bk-queue .sum-banner');
  const waiting = queue.filter((q) => !/已入座|完成|取消/.test(String(q.status || '')));
  if (qBanner && queue.length) {
    const cur = waiting[0] || queue[0];
    const val = qBanner.querySelector('.sb-val');
    if (val) val.textContent = cur.queue_no || '—';
    const delta = qBanner.querySelector('.sb-delta');
    if (delta) delta.textContent = `等位 ${waiting.length} 桌`;
  }
  const qCard = findCardIn('#bk-queue', '当前排队');
  if (qCard && queue.length) {
    qCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    queue.slice(0, 6).forEach((q) => {
      const line = document.createElement('div');
      line.className = 'stat-line';
      line.innerHTML = `<span>${esc(q.queue_no)} | ${esc(q.party_size)} 人</span><span class="tag warn">${esc(q.status || '')}</span>`;
      qCard.appendChild(line);
    });
  }
}

function applyFoodsafeModule(snap) {
  const ext = snap.ext || {};
  const certs = Array.isArray(ext.fs_certs) ? ext.fs_certs : [];
  const traces = Array.isArray(ext.fs_trace) ? ext.fs_trace : [];
  const samples = Array.isArray(ext.fs_samples) ? ext.fs_samples : [];
  const live = certs.length + traces.length + samples.length > 0;
  markModuleHead('p-m-foodsafe', live, live ? 'BFF' : '演示');

  const certCard = findCardIn('#fs-cert', '证照台账');
  if (certCard && certs.length) {
    certCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    const badge = certCard.querySelector('.badge');
    if (badge) badge.textContent = String(certs.length);
    certs.slice(0, 8).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'rc-row';
      const st = c.status || '正常';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(c.cert_type || '证照')} | ${esc(c.holder || '')}</div>` +
        `<div class="ds">${esc(c.expire_at || '')} 到期 | ${esc(c.cert_no || '')}</div></div>` +
        `<span class="tag ${/预警|过期|待/.test(st) ? 'warn' : 'ok'}">${esc(st)}</span>`;
      certCard.appendChild(row);
    });
  }

  const traceCard = findCardIn('#fs-trace', '批次追溯');
  if (traceCard && traces.length) {
    traceCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    traces.slice(0, 6).forEach((t) => {
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(t.ing_name || '')} | 批次 ${esc(t.batch_no || '')}</div>` +
        `<div class="ds">供应商 ${esc(t.supplier || '')} | ${esc(t.check_result || t.recv_date || '')}</div></div>` +
        `<span class="tag ok">已溯源</span>`;
      traceCard.appendChild(row);
    });
  }

  const samplePage = document.querySelector('#fs-sample');
  if (samplePage && samples.length) {
    const card = samplePage.querySelector('.card');
    if (card) {
      card.querySelectorAll('.rc-row').forEach((r) => r.remove());
      samples.slice(0, 6).forEach((s) => {
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(s.dish || '')} | ${esc(s.meal || '')}</div>` +
          `<div class="ds">${esc(s.weight_g || '')}g | ${esc(s.keeper || '')} | ${esc(s.kept_at || s.date || '')}</div></div>` +
          `<span class="tag ok">留样</span>`;
        card.appendChild(row);
      });
    }
  }
}

function applyStaffModule(snap) {
  const ext = snap.ext || {};
  const shifts = Array.isArray(ext.staff_shifts) ? ext.staff_shifts : [];
  const clocks = Array.isArray(ext.staff_clock) ? ext.staff_clock : [];
  const today = todayStr();
  const todayShifts = shifts.filter((s) => String(s.date || '') === today);
  const live = todayShifts.length + clocks.length > 0;
  markModuleHead('p-m-staff', live, live ? 'BFF' : '演示');

  const schedCard = document.querySelector('#st-sched .card');
  if (schedCard && todayShifts.length) {
    const ttl = schedCard.querySelector('.card-h .ttl');
    if (ttl) ttl.innerHTML = `<i class="em"></i>今日排班 | ${todayShifts.length} 人`;
    let sum = schedCard.querySelector('.bff-staff-sum');
    if (!sum) {
      sum = document.createElement('div');
      sum.className = 'bff-staff-sum';
      const head = schedCard.querySelector('.card-h');
      if (head) head.after(sum);
    }
    sum.innerHTML = todayShifts
      .slice(0, 8)
      .map(
        (s) =>
          `<div class="stat-line"><span>${esc(s.staff_name)} | ${esc(s.role || '')}</span><span><b>${esc(s.shift)}</b> ${esc(s.start_time)}-${esc(s.end_time)}</span></div>`,
      )
      .join('');
  }

  const clockCard = findCardIn('#st-clock', '今日打卡');
  if (clockCard && clocks.length) {
    const fresh = clockCard.querySelector('.fresh');
    if (fresh) fresh.innerHTML = `<i class="dot"></i>${clocks.length} 条`;
    let box = clockCard.querySelector('.bff-clock-sum');
    if (!box) {
      box = document.createElement('div');
      box.className = 'bff-clock-sum';
      clockCard.appendChild(box);
    }
    box.innerHTML = clocks
      .slice(0, 6)
      .map(
        (c) =>
          `<div class="stat-line"><span>${esc(c.staff_id)} | ${esc(c.kind)}</span><span>${esc(String(c.ts || '').slice(11, 19))} | ${esc(c.status || '')}</span></div>`,
      )
      .join('');
  }
}

function applyAnalysisOneChart(report, snap) {
  markModuleHead('p-m-analysis', !report?.mock && !!report?.ok, report?.mock ? '演示' : 'BFF');
  const trendBanner = document.querySelector('#an-trend .sum-banner');
  if (trendBanner && report?.ok && Array.isArray(report.kpi) && report.kpi[0]) {
    trendBanner.querySelector('.sb-lab').textContent = report.mock
      ? '演示营收（mock）'
      : `今日营收 | ${report.date || todayStr()}`;
    trendBanner.querySelector('.sb-val').innerHTML =
      `${esc(report.kpi[0].value)} <small>| 订单 ${esc(report.kpi[1]?.value || '0')}</small>`;
    trendBanner.querySelector('.sb-delta').textContent = report.mock
      ? '无真实 sales，以下为结构演示'
      : `rev ${report.rev} | 原料 ${report.kpi[4]?.value || '—'} SKU`;
  }

  // 时段热力：复用 heat_mini 到 an-heat
  const heatGrid = document.getElementById('heatGrid');
  if (heatGrid && Array.isArray(report?.heat_mini) && report.heat_mini.length) {
    const max = Math.max(...report.heat_mini.map((h) => h.orders || 0), 1);
    const tip = document.getElementById('heatTip');
    if (tip) tip.textContent = `BFF 分时订单（max ${max}）`;
  }

  // 备货建议：快照内低于安全线的原料（qty-first 取数，与 applyInventory 统一）
  const fcst = document.querySelector('#an-fcst');
  if (fcst && snap?.data?.ings) {
    const low = (snap.data.ings || []).filter((it) => {
      const qty = parseFloat(it.qty ?? it.stock);
      const safe = parseFloat(it.safe ?? it.safety);
      return !isNaN(qty) && !isNaN(safe) && qty < safe;
    });
    let card = null;
    fcst.querySelectorAll('.card').forEach((c) => {
      if (c.querySelector('.ttl')?.textContent?.includes('备货建议')) card = c;
    });
    if (card && low.length) {
      card.querySelectorAll('.rs-row').forEach((r, i) => {
        if (i >= low.length) return;
        const it = low[i];
        const qty = parseFloat(it.qty ?? it.stock);
        const safe = parseFloat(it.safe ?? it.safety);
        const need = Math.max(0, safe - qty);
        const unit = it.unit || 'kg';
        const ti = r.querySelector('.ti');
        if (ti) ti.textContent = `${it.name} | 备货 ${formatQty(need)}`;
        const dsSpan = r.querySelector('.fcst-ds');
        if (dsSpan) {
          // 只更新文本与 data-*，保留 span.fcst-ds 供 app.js updateFcstConf 使用
          const prec = need < 1 ? 2 : 1;
          const p = +need.toFixed(prec);
          dsSpan.dataset.pred = String(p);
          dsSpan.dataset.prec = String(prec);
          dsSpan.dataset.unit = unit;
          dsSpan.textContent = `保守 ${(p * 0.82).toFixed(prec)} / 预测 ${p.toFixed(prec)} / 乐观 ${(p * 1.18).toFixed(prec)} ${unit}`;
          while (dsSpan.nextSibling) dsSpan.nextSibling.remove();
          dsSpan.after(document.createTextNode(` · 现 ${formatQty(qty)} / 安全 ${formatQty(safe)} | BFF`));
        } else {
          const ds = r.querySelector('.ds');
          if (ds) ds.textContent = `现 ${formatQty(qty)} / 安全 ${formatQty(safe)} | BFF`;
        }
      });
    }
  }
}

function applySnapshot(snap, report) {
  if (!snap?.ok || !snap.data) return false;
  if (snap.rev != null) setRev(snap.rev);
  if (report?.kitchen) snap._reportKitchen = report.kitchen;

  applyHomeBookingAndStatus(snap);
  applyInventory(snap);
  applyKitchen(snap);
  applyBookingModule(snap);
  applyFoodsafeModule(snap);
  applyStaffModule(snap);
  if (report) applyAnalysisOneChart(report, snap);
  return true;
}

/* ---------------- Wave5: modules / restock-suggest / kitchen 端点水合 ---------------- */

const MX_QUAD = {
  star: { name: '明星', color: '#5BA85B', tip: '高销高利，建议主推位前置' },
  puzzle: { name: '问题', color: '#F2B233', tip: '高销低利，建议优化成本/试点提价' },
  cow: { name: '金牛', color: '#9B6BBF', tip: '低销稳利，保持出品可搭套餐' },
  dog: { name: '瘦狗', color: '#888', tip: '低销低利，建议调馅或下架' },
};

const MX_COLOR_MAP = {
  红: '#E8584A',
  黄: '#F2B233',
  绿: '#5BA85B',
  紫: '#9B6BBF',
  黑: '#3a3a3a',
  白: '#888',
  狮: '#C8651A',
  鱼: '#3A6EA5',
  凉: '#A24E7E',
};

const WUFU_DOT = { 红: 'f-red', 黄: 'f-yel', 绿: 'f-grn', 紫: 'f-pur', 黑: 'f-blk', 白: 'f-wht' };

/* ---------- 经营分析 ---------- */

function renderTrendBars(trend) {
  const page = document.getElementById('an-trend');
  if (!page) return;
  let card = null;
  page.querySelectorAll('.card').forEach((c) => {
    if (c.querySelector('.ttl')?.textContent?.includes('趋势')) card = c;
  });
  if (!card) return;
  const svg = card.querySelector('svg.spark');
  if (!svg) return; // 已渲染过则跳过（svg 已被柱状替换）
  const rows = trend.slice(-7);
  const max = Math.max(...rows.map((t) => parseFloat(t.revenue) || 0), 1);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;height:78px;margin:4px 0 2px';
  rows.forEach((t) => {
    const rev = parseFloat(t.revenue) || 0;
    const h = Math.max(6, Math.round((rev / max) * 58));
    const col = document.createElement('div');
    col.style.cssText = 'flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;min-width:0';
    col.innerHTML =
      `<div style="font-size:9px;color:#8A8F98">${esc(fmtMoney(rev))}</div>` +
      `<div title="${esc(t.date)}" style="width:100%;max-width:34px;height:${h}px;border-radius:4px 4px 0 0;background:linear-gradient(180deg,#F48FB1,#C2185B)"></div>` +
      `<div style="font-size:9px;color:#8A8F98">${esc(String(t.date).slice(5))}</div>`;
    wrap.appendChild(col);
  });
  svg.replaceWith(wrap);
  const ttl = card.querySelector('.card-h .ttl');
  if (ttl) ttl.innerHTML = `<i class="em"></i>营收趋势（近 ${rows.length} 日）`;
  const legend = card.querySelector('.legend');
  if (legend) legend.innerHTML = `<span><i style="background:#F48FB1"></i>日营收（柱）</span><span style="margin-left:auto">BFF 真实聚合</span>`;
}

function applyAnalysisHeat(heatmap) {
  const grid = document.getElementById('heatGrid');
  if (!grid || !heatmap.length) return;
  const cells = grid.querySelectorAll('.heat-cell');
  if (!cells.length) return;
  const max = Math.max(...heatmap.map((h) => h.orders || 0), 1);
  const palette = ['#FFF1F5', '#FBD3CC', '#F48FB1', '#C2185B'];
  cells.forEach((c) => {
    c.style.background = '#FFF1F5';
    c.dataset.lv = '0';
  });
  heatmap.forEach((h) => {
    const hour = parseInt(h.hour, 10);
    const wd = parseInt(h.weekday, 10);
    if (isNaN(hour) || isNaN(wd) || hour < 0 || hour > 23) return;
    const row = (wd + 6) % 7; // weekday 0=周日 → 第 6 行（周一为第 0 行）
    const cell = cells[row * 24 + hour];
    if (!cell) return;
    const lv = Math.min(3, Math.round(((h.orders || 0) / max) * 3));
    cell.style.background = palette[lv];
    cell.dataset.lv = String(lv);
  });
  const tip = document.getElementById('heatTip');
  if (tip) tip.textContent = `BFF 分时订单（峰值 ${max} 单/小时）`;
}

function applyMatrix(matrix) {
  if (!matrix.length) return;
  const svg = document.getElementById('matrixSvg');
  if (!svg) return;
  // 清掉原型圆点与点标签（保留象限底色/坐标轴/象限文字）
  svg.querySelectorAll('circle').forEach((c) => c.remove());
  svg.querySelectorAll('text').forEach((t) => {
    if (t.getAttribute('fill') === '#fff') t.remove();
  });
  const maxV = Math.max(...matrix.map((d) => parseFloat(d.volume) || 0), 1);
  const maxM = Math.max(...matrix.map((d) => parseFloat(d.margin) || 0), 0.6);
  const NS = 'http://www.w3.org/2000/svg';
  matrix.slice(0, 24).forEach((d) => {
    const v = parseFloat(d.volume) || 0;
    const m = Math.max(0, parseFloat(d.margin) || 0);
    const x = 50 + (v / maxV) * 240;
    const y = 170 - Math.min(1, m / maxM) * 140;
    const ch = String(d.name || '?').trim().charAt(0) || '?';
    const color = MX_COLOR_MAP[ch] || MX_QUAD[d.quadrant]?.color || '#3A6EA5';
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x.toFixed(1));
    c.setAttribute('cy', y.toFixed(1));
    c.setAttribute('r', '8');
    c.setAttribute('fill', color);
    svg.appendChild(c);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x.toFixed(1));
    t.setAttribute('y', (y + 3).toFixed(1));
    t.setAttribute('font-size', '8');
    t.setAttribute('fill', '#fff');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-weight', '700');
    t.textContent = ch;
    svg.appendChild(t);
  });
  // 图例 + 钻取数据（drillMatrix 读全局 MATRIX_DISHES）
  const byQ = { star: [], puzzle: [], cow: [], dog: [] };
  matrix.forEach((d) => {
    const q = byQ[d.quadrant] ? d.quadrant : 'dog';
    byQ[q].push(d);
  });
  const toRow = (d, q) => [
    String(d.name || '未命名'),
    `销量 ${formatQty(d.volume)} · 毛利 ${((parseFloat(d.margin) || 0) * 100).toFixed(1)}%`,
    MX_QUAD[q].tip,
  ];
  const drill = {};
  Object.keys(byQ).forEach((q) => {
    drill[q] = byQ[q].map((d) => toRow(d, q));
  });
  drill.all = matrix.map((d) => toRow(d, byQ[d.quadrant] ? d.quadrant : 'dog'));
  window.MATRIX_DISHES = drill;
  const legend = document.querySelector('#an-mx .mx-legend');
  if (legend) {
    legend.innerHTML = Object.keys(MX_QUAD)
      .map((q) => {
        const names = byQ[q]
          .slice(0, 3)
          .map((d) => esc(String(d.name || '').slice(0, 6)))
          .join('/');
        return `<span class="lg" data-q="${q}" onclick="drillMatrix('${q}')"><i style="background:${MX_QUAD[q].color}"></i>${MX_QUAD[q].name}（${byQ[q].length}）${names ? '：' + names : ''}</span>`;
      })
      .join('');
  }
  const more = document.querySelector('#an-mx .card-h .more');
  if (more) more.textContent = `${matrix.length} 款`;
}

function applyEfficiency(eff) {
  if (!eff) return;
  const page = document.getElementById('an-eff');
  if (!page) return;
  let card = null;
  page.querySelectorAll('.card').forEach((c) => {
    if (c.querySelector('.ttl')?.textContent?.includes('同环比')) card = c;
  });
  if (!card) return;
  card.querySelectorAll('.stat-line').forEach((r) => r.remove());
  const wdName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][eff.peak_weekday] || '';
  const lines = [
    ['客单价', fmtMoney(eff.avg_ticket)],
    ['日均营收', fmtMoney(eff.daily_avg_revenue)],
    ['统计订单', `${eff.total_orders ?? '—'} 单`],
    ['统计天数', `${eff.days ?? '—'} 天`],
    ['高峰时段', eff.peak_hour != null ? `${String(eff.peak_hour).padStart(2, '0')}:00 ${wdName}`.trim() : '—'],
  ];
  lines.forEach(([k, v]) => {
    const div = document.createElement('div');
    div.className = 'stat-line';
    div.innerHTML = `<span>${esc(k)}</span><span style="font-weight:800">${esc(v)}</span>`;
    card.appendChild(div);
  });
  const ttl = card.querySelector('.card-h .ttl');
  if (ttl) ttl.innerHTML = '<i class="em"></i>效率明细 · BFF';
}

function applyForecast(fcst) {
  if (!fcst) return;
  const page = document.getElementById('an-fcst');
  if (!page) return;
  const peak = fcst.peak;
  const peakTxt = document.getElementById('fcstPeakTxt');
  if (peakTxt && peak) {
    peakTxt.textContent = `峰值 ${String(peak.date || '').slice(5)} · 上界${fmtMoney(peak.opt)} / 预测${fmtMoney(peak.pred)} / 下界${fmtMoney(peak.cons)}`;
  }
  const confVal = document.getElementById('fcstConfVal');
  const slider = document.getElementById('fcstConfSlider');
  if (confVal && fcst.confidence != null) confVal.textContent = String(fcst.confidence);
  if (slider && fcst.confidence != null) slider.value = String(fcst.confidence);

  const holidays = Array.isArray(fcst.holidays) ? fcst.holidays : [];
  if (holidays.length) {
    let hCard = null;
    page.querySelectorAll('.card').forEach((c) => {
      if (c.querySelector('.ttl')?.textContent?.includes('节假日')) hCard = c;
    });
    if (hCard) {
      hCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
      holidays.forEach((h) => {
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML = `<span>${esc(h.label)}</span><span class="up" style="font-weight:800">${esc(h.effect)}</span>`;
        hCard.appendChild(div);
      });
    }
  }

  const restock = Array.isArray(fcst.restock) ? fcst.restock : [];
  if (!restock.length) return;
  let rCard = null;
  page.querySelectorAll('.card').forEach((c) => {
    if (c.querySelector('.ttl')?.textContent?.includes('备货建议')) rCard = c;
  });
  if (!rCard) return;
  rCard.querySelectorAll('.rs-row').forEach((r) => r.remove());
  const note = rCard.querySelector('.note');
  restock.slice(0, 8).forEach((it) => {
    const pred = parseFloat(it.pred);
    if (isNaN(pred)) return;
    const prec = pred < 1 ? 2 : 1;
    const unit = it.unit || 'kg';
    const cons = it.cons != null ? parseFloat(it.cons) : pred * 0.82;
    const opt = it.opt != null ? parseFloat(it.opt) : pred * 1.18;
    const row = document.createElement('div');
    row.className = 'rs-row';
    row.innerHTML =
      `<div class="info"><div class="ti">${esc(it.name || '原料')} · 备货区间</div>` +
      `<div class="ds"><span class="fcst-ds" data-pred="${pred}" data-prec="${prec}" data-unit="${esc(unit)}">保守 ${cons.toFixed(prec)} / 预测 ${pred.toFixed(prec)} / 乐观 ${opt.toFixed(prec)} ${esc(unit)}</span>` +
      `${it.reason ? ' · ' + esc(it.reason) : ''}${it.qty != null ? ` · 现库 ${formatQty(it.qty)}${esc(unit)}` : ''}</div>` +
      `<span class="ai-badge">${esc(it.badge || 'AI 建议')}</span></div>` +
      `<div><div class="amt">${it.amount != null ? esc(fmtMoney(it.amount)) : '—'}</div>` +
      `<span class="chip act" style="margin-top:6px;display:inline-block" onclick="openSheet('confirm')">转采购</span></div>`;
    if (note) rCard.insertBefore(row, note);
    else rCard.appendChild(row);
  });
}

function applyAnalysisApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-analysis', false, '无快照');
    return;
  }
  const mock = !!j.mock;
  markModuleHead('p-m-analysis', !mock, mock ? '演示' : 'BFF');
  if (mock) return; // 演示数据与原型一致，保留原型 DOM

  const trend = arrOf(j, 'trend');
  const heatmap = arrOf(j, 'heatmap');
  const matrix = arrOf(j, 'matrix');
  const eff = j.efficiency && typeof j.efficiency === 'object' ? j.efficiency : null;
  const fcst = j.forecast && typeof j.forecast === 'object' ? j.forecast : null;

  const banner = document.querySelector('#an-trend .sum-banner');
  if (banner && trend.length) {
    const total = trend.reduce((s, t) => s + (parseFloat(t.revenue) || 0), 0);
    const orders = trend.reduce((s, t) => s + (parseInt(t.orders, 10) || 0), 0);
    const lab = banner.querySelector('.sb-lab');
    const val = banner.querySelector('.sb-val');
    const dlt = banner.querySelector('.sb-delta');
    if (lab) lab.textContent = `近 ${trend.length} 日营收 | ${trend[0].date} ~ ${trend[trend.length - 1].date}`;
    if (val) val.innerHTML = `${esc(fmtMoney(total))} <small>| 订单 ${esc(orders)} · 日均 ${esc(fmtMoney(eff?.daily_avg_revenue))}</small>`;
    if (dlt) {
      dlt.textContent = `rev ${esc(j.rev ?? '—')} | BFF 真实聚合`;
      dlt.className = 'sb-delta up';
    }
  }
  if (trend.length >= 2) renderTrendBars(trend);
  applyAnalysisHeat(heatmap);
  applyMatrix(matrix);
  applyEfficiency(eff);
  applyForecast(fcst);
}

/* ---------- 排班员工 ---------- */

function weekDates() {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 周一=0
  const mon = new Date(now.getTime() - dow * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon.getTime() + i * 86400000);
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return out;
}

function shiftHours(s) {
  const a = String(s.start_time || '').match(/(\d{1,2}):(\d{2})/);
  const b = String(s.end_time || '').match(/(\d{1,2}):(\d{2})/);
  if (!a || !b) return 8;
  let h = (parseInt(b[1], 10) * 60 + parseInt(b[2], 10) - (parseInt(a[1], 10) * 60 + parseInt(a[2], 10))) / 60;
  if (h <= 0) h += 24;
  return Math.min(h, 16);
}

function renderWeekSched(shifts) {
  const grid = document.querySelector('#st-sched .wk-sched');
  if (!grid || !shifts.length) return;
  const days = weekDates();
  const byStaff = {};
  shifts.forEach((s) => {
    const name = s.staff_name || s.name || s.staff_id;
    const d = String(s.date || '').slice(0, 10);
    if (!name || !d) return;
    if (!byStaff[name]) byStaff[name] = {};
    byStaff[name][d] = s;
  });
  const names = Object.keys(byStaff);
  if (!names.length) return;
  grid.querySelectorAll('.rl, .shft').forEach((n) => n.remove());
  const more = document.querySelector('#st-sched .card-h .more');
  if (more) more.textContent = `${days[0].slice(5)}–${days[6].slice(5)}`;
  names.slice(0, 8).forEach((name) => {
    const rl = document.createElement('div');
    rl.className = 'rl';
    rl.textContent = name;
    grid.appendChild(rl);
    days.forEach((d) => {
      const s = byStaff[name][d];
      const cell = document.createElement('div');
      const raw = String((s && (s.shift || s.shift_type || s.type)) || '');
      // 中文班次映射：早→A / 中→B / 晚(夜)→C
      const cnMap = /早/.test(raw) ? 'A' : /中/.test(raw) ? 'B' : /晚|夜/.test(raw) ? 'C' : null;
      const letter = cnMap || raw.trim().charAt(0).toUpperCase();
      if (!s) {
        cell.className = 'shft sh-R';
        cell.textContent = '·';
      } else if (/休|假|R/i.test(raw)) {
        cell.className = 'shft sh-R';
        cell.textContent = '休';
      } else if (/^[ABC]$/.test(letter)) {
        cell.className = 'shft sh-' + letter;
        cell.textContent = letter;
      } else {
        cell.className = 'shft sh-A';
        cell.textContent = raw.slice(0, 1) || '班';
      }
      if (s) cell.title = `${d} ${raw} ${s.start_time || ''}-${s.end_time || ''}`.trim();
      grid.appendChild(cell);
    });
  });
}

function renderWorkHours(shifts) {
  if (!shifts.length) return;
  let card = null;
  document.querySelectorAll('#st-sched .card').forEach((c) => {
    if (c.querySelector('.ttl')?.textContent?.includes('工时')) card = c;
  });
  if (!card) return;
  const days = new Set(weekDates());
  const hours = {};
  shifts.forEach((s) => {
    const name = s.staff_name || s.name || s.staff_id;
    const d = String(s.date || '').slice(0, 10);
    if (!name || !days.has(d)) return;
    if (/休|假/.test(String(s.shift || ''))) return;
    hours[name] = (hours[name] || 0) + shiftHours(s);
  });
  const names = Object.keys(hours);
  if (!names.length) return;
  card.querySelectorAll('.fb-row').forEach((r) => r.remove());
  names.slice(0, 8).forEach((n) => {
    const h = Math.round(hours[n] * 10) / 10;
    const pct = Math.min(100, Math.round((hours[n] / 56) * 100));
    const row = document.createElement('div');
    row.className = 'fb-row';
    row.innerHTML = `<div class="lb">${esc(n)}</div><div class="fb-bar"><i style="width:${pct}%;background:linear-gradient(90deg,#F48FB1,#9B6BBF)"></i></div><div class="vl">${h}h</div>`;
    card.appendChild(row);
  });
}

function renderClockDetail(clock) {
  if (!clock.length) return;
  const cards = document.querySelectorAll('#st-clock .card');
  const sumCard = cards[0];
  const detCard = findCardIn('#st-clock', '打卡明细') || cards[1];
  const today = todayStr();
  const todayRows = clock.filter((c) => String(c.ts || c.time || c.date || '').indexOf(today) === 0);
  const rows = todayRows.length ? todayRows : clock;
  if (sumCard) {
    sumCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    const late = rows.filter((c) => /迟/.test(String(c.status || ''))).length;
    const absent = rows.filter((c) => /缺|旷/.test(String(c.status || ''))).length;
    const on = rows.filter((c) => /在岗|正常|准点/.test(String(c.status || ''))).length;
    const fresh = sumCard.querySelector('.fresh');
    if (fresh) fresh.innerHTML = `<i class="dot"></i>${rows.length} 条`;
    [
      ['打卡记录', `<b>${rows.length}</b> 条`],
      ['在岗', `<span class="tag ok">${on} 人</span>`],
      ['迟到', `<span class="tag warn">${late} 人</span>`],
      ['缺勤', `<span class="tag danger">${absent} 人</span>`],
    ].forEach(([k, v]) => {
      const div = document.createElement('div');
      div.className = 'stat-line';
      div.innerHTML = `<span>${esc(k)}</span><span>${v}</span>`;
      sumCard.appendChild(div);
    });
  }
  if (detCard) {
    detCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    rows.slice(0, 8).forEach((c) => {
      const name = c.staff_name || c.name || c.staff_id || '员工';
      const st = c.status || '已打卡';
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(name)} · ${esc(c.kind || '打卡')}</div>` +
        `<div class="ds">${esc(String(c.ts || c.time || '').slice(5, 16))}</div></div>` +
        `<span class="tag ${/迟|缺|异常/.test(String(st)) ? 'warn' : 'ok'}">${esc(st)}</span>`;
      detCard.appendChild(row);
    });
  }
}

function renderPerf(perf, nameMap) {
  if (!perf.length) return;
  const card = document.querySelector('#st-perf .card');
  const box = card ? card.querySelector('.top3') : null;
  if (!box) return;
  const rows = perf.slice().sort((a, b) => (parseFloat(b.score ?? b.value) || 0) - (parseFloat(a.score ?? a.value) || 0));
  const rankBg = [
    'linear-gradient(135deg,#F2B233,#E8920C)',
    'linear-gradient(135deg,#9aa,#3a3a3a)',
    'linear-gradient(135deg,#FFB6B0,#E8584A)',
  ];
  box.innerHTML = '';
  rows.slice(0, 6).forEach((p, i) => {
    const id = p.staff_id;
    const name = p.staff_name || p.name || (nameMap && id && nameMap[id]) || id || '员工';
    const score = p.score ?? p.value ?? '—';
    const desc = p.note || p.desc || p.summary || p.remark || (p.output != null ? `出品 ${p.output} 份` : '') || '';
    const div = document.createElement('div');
    div.className = 'tr';
    div.innerHTML =
      `<div class="rank" style="background:${rankBg[i] || '#D8DBE0'};${i >= 3 ? 'color:#666' : ''}">${i + 1}</div>` +
      `<div class="info"><div class="nm">${esc(name)}</div><div class="sl">${esc(String(desc).slice(0, 40))}</div></div>` +
      `<div class="vl">${esc(score)}</div>`;
    box.appendChild(div);
  });
}

function renderTrain(train) {
  if (!train.length) return;
  const card = document.querySelector('#st-train .card');
  if (!card) return;
  card.querySelectorAll('.stat-line').forEach((r) => r.remove());
  train.slice(0, 8).forEach((t) => {
    const name = t.staff_name || t.name || '员工';
    const course = t.course || t.item || t.sku || '培训';
    const st = t.status || (t.passed ? '已通过' : '进行中');
    const prog = t.progress || (t.done != null && t.total != null ? `${t.done}/${t.total}` : '') || t.remark || '';
    const div = document.createElement('div');
    div.className = 'stat-line';
    div.innerHTML = `<span>${esc(name)} · ${esc(course)}</span><span class="tag ${/通过|完成/.test(String(st)) ? 'ok' : 'warn'}">${esc(st)}${prog ? ' ' + esc(prog) : ''}</span>`;
    card.appendChild(div);
  });
}

function applyStaffApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-staff', false, '无快照');
    return;
  }
  const shifts = arrOf(j, 'shifts');
  const clock = arrOf(j, 'clock');
  const perf = arrOf(j, 'perf');
  const train = arrOf(j, 'train');
  const live = shifts.length + clock.length + perf.length + train.length > 0;
  markModuleHead('p-m-staff', live, live ? 'BFF' : '演示');
  if (!live) return;
  const nameMap = {};
  shifts.forEach((s) => {
    if (s.staff_id && s.staff_name && !nameMap[s.staff_id]) nameMap[s.staff_id] = s.staff_name;
  });
  renderWeekSched(shifts);
  renderWorkHours(shifts);
  renderClockDetail(clock);
  renderPerf(perf, nameMap);
  renderTrain(train);
}

/* ---------- 会员营销 ---------- */

function applyVipApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-vip', false, '无快照');
    return;
  }
  const members = arrOf(j, 'members');
  const coupons = arrOf(j, 'coupons');
  const visits = arrOf(j, 'visits');
  const live = members.length + coupons.length + visits.length > 0;
  markModuleHead('p-m-vip', live, live ? 'BFF' : '演示');
  if (!live) return;

  const nameOf = (m) => m.name || m.member_name || m.member_id || '会员';

  const banner = document.querySelector('#vip-overview .sum-banner');
  if (banner && members.length) {
    const total = members.reduce((s, m) => s + (parseFloat(m.balance) || 0), 0);
    const lab = banner.querySelector('.sb-lab');
    const val = banner.querySelector('.sb-val');
    const dlt = banner.querySelector('.sb-delta');
    if (lab) lab.textContent = '会员储值余额合计';
    if (val) val.innerHTML = `${esc(fmtMoney(total))} <small>| 会员 ${members.length} 人</small>`;
    if (dlt) dlt.textContent = `rev ${esc(j.rev ?? '—')} | 快照真实会员`;
  }

  const stCard = findCardIn('#vip-overview', '会员结构');
  if (stCard && members.length) {
    const more = stCard.querySelector('.card-h .more');
    if (more) more.textContent = `${members.length} 人`;
    const hole = stCard.querySelector('.donut .pct');
    if (hole) hole.textContent = String(members.length);
    const typed = {};
    members.forEach((m) => {
      const t = m.type || m.level || m.kind || ((parseFloat(m.balance) || 0) > 0 ? '储值卡' : '普通');
      typed[t] = (typed[t] || 0) + 1;
    });
    const leg = stCard.querySelector('.donut-leg');
    if (leg) {
      const colors = ['#E8584A', '#F2B233', '#9B6BBF', '#5BA85B', '#3A6EA5'];
      leg.innerHTML = Object.keys(typed)
        .slice(0, 5)
        .map(
          (t, i) =>
            `<div class="li"><span><i style="background:${colors[i % colors.length]}"></i>${esc(t)} ${typed[t]} (${Math.round((typed[t] / members.length) * 100)}%)</span></div>`,
        )
        .join('');
    }
  }

  const balCard = findCardIn('#vip-balance', '大额储值');
  if (balCard && members.length) {
    balCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    members
      .slice()
      .sort((a, b) => (parseFloat(b.balance) || 0) - (parseFloat(a.balance) || 0))
      .slice(0, 5)
      .forEach((m) => {
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(nameOf(m))} · 余额 ${esc(fmtMoney(m.balance))}</div>` +
          `<div class="ds">${esc(m.type || m.level || '会员')}${m.phone ? ' · ' + esc(m.phone) : ''}${m.birthday ? ' · 生日 ' + esc(String(m.birthday).slice(5, 10)) : ''}</div></div>` +
          `<span class="tag ok">储值</span>`;
        balCard.appendChild(row);
      });
  }

  const cpCard = findCardIn('#vip-coupon', '优惠券核销');
  if (cpCard && coupons.length) {
    cpCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    const bySt = {};
    coupons.forEach((c) => {
      const s = c.status || '已发';
      bySt[s] = (bySt[s] || 0) + 1;
    });
    const head = document.createElement('div');
    head.className = 'stat-line';
    head.innerHTML = `<span>券总数</span><span><b>${coupons.length} 张</b></span>`;
    cpCard.appendChild(head);
    Object.keys(bySt)
      .slice(0, 4)
      .forEach((s) => {
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML = `<span>${esc(s)}</span><span class="up" style="font-weight:800">${bySt[s]} 张</span>`;
        cpCard.appendChild(div);
      });
    const actCard = findCardIn('#vip-coupon', '活动券');
    if (actCard) {
      actCard.querySelectorAll('.coupon-card').forEach((r) => r.remove());
      const note = actCard.querySelector('.note');
      coupons.slice(0, 6).forEach((c) => {
        const div = document.createElement('div');
        div.className = 'coupon-card';
        div.innerHTML =
          `<div class="cc-h"><div><div class="cc-ti">${esc(c.title || c.name || (c.type ? `${c.type}券${c.value != null ? ' ¥' + c.value : ''}` : '优惠券'))}</div>` +
          `<div class="cc-ds">${esc(c.note || c.desc || (c.used_count != null ? `已核销 ${c.used_count}` : c.code ? `券号 ${String(c.code).slice(-6)}` : ''))}</div></div>` +
          `<span class="cc-st cc-s-sent">${esc(c.status || '已发')}</span></div>`;
        if (note) actCard.insertBefore(div, note);
        else actCard.appendChild(div);
      });
    }
  }

  const bdCard = document.querySelector('#vip-birthday .card');
  if (bdCard) {
    const soon = members.filter((m) => m.birthday_soon);
    if (soon.length) {
      bdCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
      const badge = bdCard.querySelector('.badge');
      if (badge) badge.textContent = String(soon.length);
      const note = bdCard.querySelector('.note');
      soon.slice(0, 6).forEach((m) => {
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(nameOf(m))} · ${esc(m.type || '会员')}</div>` +
          `<div class="ds">生日 ${esc(String(m.birthday || '').slice(5, 10) || '本周')}${m.phone ? ' · ' + esc(m.phone) : ''}</div></div>` +
          `<button class="pbtn" onclick="openSheet('confirm')">发券</button>`;
        if (note) bdCard.insertBefore(row, note);
        else bdCard.appendChild(row);
      });
    }
  }
}

/* ---------- 外卖平台 ---------- */

function applyTakeoutApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-takeout', false, '无快照');
    return;
  }
  const platforms = arrOf(j, 'platforms');
  const orders = arrOf(j, 'orders');
  const reviews = arrOf(j, 'reviews');
  const reconcile = arrOf(j, 'reconcile');
  const live = platforms.length + orders.length + reviews.length + reconcile.length > 0;
  markModuleHead('p-m-takeout', live, live ? 'BFF' : '演示');
  if (!live) return;

  const amt = (r) => parseFloat(r.amount ?? r.total ?? r.price) || 0;

  const banner = document.querySelector('#to-overview .sum-banner');
  if (banner && orders.length) {
    const total = orders.reduce((s, o) => s + amt(o), 0);
    const val = banner.querySelector('.sb-val');
    const dlt = banner.querySelector('.sb-delta');
    if (val) val.innerHTML = `${esc(fmtMoney(total))} <small>· ${orders.length} 单</small>`;
    if (dlt) dlt.textContent = `rev ${esc(j.rev ?? '—')} | 快照外卖单`;
  }

  const platCard = findCardIn('#to-overview', '平台分布');
  const platSrc = platforms.length
    ? platforms
    : (() => {
        const by = {};
        orders.forEach((o) => {
          const p = o.platform || '其他';
          if (!by[p]) by[p] = { name: p, orders: 0, amount: 0 };
          by[p].orders += 1;
          by[p].amount += amt(o);
        });
        return Object.keys(by).map((k) => by[k]);
      })();
  if (platCard && platSrc.length) {
    platCard.querySelectorAll('.plat').forEach((r) => r.remove());
    const totalAmt = platSrc.reduce((s, p) => s + (parseFloat(p.amount ?? p.revenue) || 0), 0) || 1;
    const colors = { 美: '#FFC700', 饿: '#2396E6', 抖: '#FE2C55' };
    platSrc.slice(0, 5).forEach((p) => {
      const name = p.name || p.platform || '平台';
      const ch = String(name).charAt(0);
      const pAmt = parseFloat(p.amount ?? p.revenue) || 0;
      const pN = parseInt(p.orders ?? p.count, 10) || 0;
      const pct = Math.round((pAmt / totalAmt) * 100);
      const row = document.createElement('div');
      row.className = 'plat';
      row.innerHTML =
        `<div class="pi" style="background:${colors[ch] || '#9B6BBF'};${ch === '美' ? 'color:#333' : ''}">${esc(ch)}</div>` +
        `<div class="info"><div class="ti">${esc(name)}</div><div class="ds">${pN} 单${p.rating || p.score ? ' · 评分 ' + esc(p.rating ?? p.score) : ''}</div></div>` +
        `<div class="vl">${esc(fmtMoney(pAmt))}<small> · ${pct}%</small></div>`;
      platCard.appendChild(row);
    });
  }

  if (reconcile.length) {
    const recCard = findCardIn('#to-reconcile', 'T+1') || document.querySelector('#to-reconcile .card');
    if (recCard) {
      const recAmt = (r) => r.settle_amount ?? r.amount ?? r.actual_amt ?? r.expect_amt;
      recCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
      const note = recCard.querySelector('.note');
      const total = reconcile.reduce((s, r) => s + (parseFloat(recAmt(r)) || 0), 0);
      const tag = recCard.querySelector('.card-h .tag');
      if (tag) tag.textContent = fmtMoney(total);
      reconcile.slice(0, 6).forEach((r) => {
        const diff = parseFloat(r.diff);
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML = `<span>${esc(r.platform || '平台')} ${esc(r.period || r.cycle || '')}</span><span><b>${esc(fmtMoney(recAmt(r)))}</b>${!isNaN(diff) && diff !== 0 ? ` · 差异 ${esc(fmtMoney(diff))}` : ''}${r.status ? ' · ' + esc(r.status) : ''}</span>`;
        if (note) recCard.insertBefore(div, note);
        else recCard.appendChild(div);
      });
    }
    const detCard = findCardIn('#to-reconcile', '对账明细');
    if (detCard) {
      detCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
      reconcile.slice(0, 8).forEach((r) => {
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(r.platform || '')} ${esc(r.order_no || r.platform_no || r.id || '')}</div>` +
          `<div class="ds">${esc(r.note || r.items || r.date || r.period || '')}</div></div>` +
          `<span class="am">${esc(fmtMoney(r.settle_amount ?? r.amount ?? r.actual_amt ?? r.expect_amt))}</span>`;
        detCard.appendChild(row);
      });
    }
  }

  const bad = reviews.filter(
    (r) => (parseFloat(r.rating ?? r.score) || 5) <= 3 || /差|投诉|慢/.test(String(r.content || r.text || '')),
  );
  const badCard = findCardIn('#to-bad', '差评预警');
  if (badCard && bad.length) {
    badCard.querySelectorAll('.alert').forEach((a) => a.remove());
    const badge = badCard.querySelector('.badge');
    if (badge) badge.textContent = String(bad.length);
    const note = badCard.querySelector('.note');
    bad.slice(0, 4).forEach((r) => {
      const div = document.createElement('div');
      div.className = 'alert';
      div.style.cursor = 'pointer';
      div.innerHTML =
        `<div class="st" style="background:#E8584A"></div>` +
        `<div class="ct"><div class="t2">${esc(r.platform || '平台')} · "${esc(String(r.content || r.text || r.title || '差评').slice(0, 20))}"</div>` +
        `<div class="d2">${esc(r.order_no || r.platform_no || '')} · 评分 ${esc(r.rating ?? r.score ?? '—')}</div></div>`;
      div.onclick = () => {
        if (typeof window.goModule === 'function') window.goModule('review');
      };
      if (note) badCard.insertBefore(div, note);
      else badCard.appendChild(div);
    });
  }
}

/* ---------- 预订排队 ---------- */

function applyBookingApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-booking', false, '无快照');
    return;
  }
  const bookings = arrOf(j, 'bookings');
  const queue = arrOf(j, 'queue');
  const serves = arrOf(j, 'serves');
  const live = bookings.length + queue.length + serves.length > 0;
  markModuleHead('p-m-booking', live, live ? 'BFF' : '演示');
  if (!live) return;
  const people = bookings.reduce((s, b) => s + (parseInt(b.party_size ?? b.people, 10) || 0), 0);

  const banner = document.querySelector('#bk-today .sum-banner');
  if (banner) {
    const lab = banner.querySelector('.sb-lab');
    const val = banner.querySelector('.sb-val');
    const dlt = banner.querySelector('.sb-delta');
    if (lab) lab.textContent = `今日预订 | ${esc(j.date || todayStr())}`;
    if (val) val.textContent = `${bookings.length} 桌 / ${people} 人`;
    const confirmed = bookings.filter((b) => /确认|已/.test(String(b.status || ''))).length;
    if (dlt) dlt.textContent = `已确认 ${confirmed} | 待确认 ${bookings.length - confirmed}`;
  }
  const listCard = findCardIn('#bk-today', '预订清单');
  if (listCard) {
    listCard.querySelectorAll('.rc-row, .empty-hint').forEach((r) => r.remove());
    if (bookings.length) {
      bookings.slice(0, 8).forEach((b) => {
        const row = document.createElement('div');
        row.className = 'rc-row';
        const st = b.status || '待确认';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(b.time || '')} · ${esc(b.guest_name || b.name || '')} ${esc(b.party_size ?? '')} 人</div>` +
          `<div class="ds">电话 ${esc(b.phone || '')} · ${esc(b.table_id || b.table_no || '')}</div></div>` +
          `<span class="tag ${/确认|已/.test(String(st)) ? 'ok' : 'warn'}">${esc(st)}</span>`;
        listCard.appendChild(row);
      });
    } else {
      listCard.insertAdjacentHTML('beforeend', emptyStateHtml('今日暂无预订'));
    }
  }

  const waiting = queue.filter((q) => !/已入座|完成|取消/.test(String(q.status || '')));
  const qBanner = document.querySelector('#bk-queue .sum-banner');
  if (qBanner) {
    const cur = waiting[0] || queue[0];
    const val = qBanner.querySelector('.sb-val');
    if (val) val.textContent = cur ? cur.queue_no || '—' : '—';
    const dlt = qBanner.querySelector('.sb-delta');
    if (dlt) dlt.textContent = `等位 ${waiting.length} 桌`;
  }
  const qCard = findCardIn('#bk-queue', '当前排队');
  if (qCard) {
    qCard.querySelectorAll('.stat-line, .empty-hint').forEach((r) => r.remove());
    if (queue.length) {
      queue.slice(0, 6).forEach((q) => {
        const line = document.createElement('div');
        line.className = 'stat-line';
        line.innerHTML = `<span>${esc(q.queue_no)} · ${esc(q.party_size ?? '')} 人</span><span class="tag ${/已入座/.test(String(q.status || '')) ? 'ok' : 'warn'}">${esc(q.status || '')}</span>`;
        qCard.appendChild(line);
      });
    } else {
      qCard.insertAdjacentHTML('beforeend', emptyStateHtml('当前无排队'));
    }
  }
  const svCard = findCardIn('#bk-queue', '候餐服务');
  if (svCard && serves.length) {
    svCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    const byKind = {};
    serves.forEach((s) => {
      const k = s.kind || s.action || s.item || s.type || '服务';
      byKind[k] = (byKind[k] || 0) + (parseInt(s.qty, 10) || 1);
    });
    Object.keys(byKind)
      .slice(0, 5)
      .forEach((k) => {
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML = `<span>${esc(k)}</span><span><b>${byKind[k]} 次</b></span>`;
        svCard.appendChild(div);
      });
  }

  // bk-turn 翻台预估
  const turnCard = document.querySelector('#bk-turn .card');
  if (turnCard) {
    const waits = serves.map((s) => parseFloat(s.wait_min ?? s.wait ?? s.waited ?? s.wait_eta_min)).filter((n) => !isNaN(n));
    const durs = serves.map((s) => parseFloat(s.duration_min ?? s.dine_min ?? s.duration)).filter((n) => !isNaN(n) && n > 0);
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const avgWait = avg(waits);
    const avgDur = avg(durs);
    const sBanner = turnCard.querySelector('.sum-banner');
    if (sBanner && (avgWait != null || avgDur != null)) {
      const val = sBanner.querySelector('.sb-val');
      if (val) val.textContent = `~${avgDur ?? avgWait} 分钟`;
      const dlt = sBanner.querySelector('.sb-delta');
      if (dlt) dlt.textContent = `候餐服务 ${serves.length} 单 | BFF`;
    }
    turnCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    const lines = [
      ['今日预订', `${bookings.length} 桌 / ${people} 人`],
      ['当前等位', `${waiting.length} 桌`],
      ['候餐服务', `${serves.length} 单`],
    ];
    if (avgWait != null) lines.push(['平均等位', `~${avgWait} 分钟`]);
    if (avgDur != null) lines.push(['平均用餐', `~${avgDur} 分钟`]);
    lines.forEach(([k, v]) => {
      const div = document.createElement('div');
      div.className = 'stat-line';
      div.innerHTML = `<span>${esc(k)}</span><span><b>${esc(v)}</b></span>`;
      turnCard.appendChild(div);
    });
  }
}

/* ---------- 食安证照 ---------- */

function applyFoodsafeApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-foodsafe', false, '无快照');
    return;
  }
  const certs = arrOf(j, 'certs');
  const trace = arrOf(j, 'trace');
  const samples = arrOf(j, 'samples');
  const disinfect = arrOf(j, 'disinfect');
  const live = certs.length + trace.length + samples.length + disinfect.length > 0;
  markModuleHead('p-m-foodsafe', live, live ? 'BFF' : '演示');
  if (!live) return;

  const certCard = findCardIn('#fs-cert', '证照台账');
  if (certCard && certs.length) {
    certCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    const badge = certCard.querySelector('.badge');
    if (badge) badge.textContent = String(certs.length);
    certs.slice(0, 8).forEach((c) => {
      const st = c.status || '正常';
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(c.cert_type || c.type || '证照')} · ${esc(c.holder || c.name || '')}</div>` +
        `<div class="ds">${esc(c.expire_at || c.expire || '')} 到期 · ${esc(c.cert_no || c.no || '')}</div></div>` +
        `<span class="tag ${/预警|过期|待/.test(String(st)) ? 'warn' : 'ok'}">${esc(st)}</span>`;
      certCard.appendChild(row);
    });
  }

  const traceCard = findCardIn('#fs-trace', '批次追溯');
  if (traceCard && trace.length) {
    traceCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    trace.slice(0, 6).forEach((t) => {
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(t.name || t.ing_name || '')} · 批次 ${esc(t.batch || t.batch_no || '')}</div>` +
        `<div class="ds">供应商 ${esc(t.supplier || t.vendor || '')} · ${esc(t.check_result || t.recv_date || t.date || '')}</div></div>` +
        `<span class="tag ok">已溯源</span>`;
      traceCard.appendChild(row);
    });
  }

  const samplePage = document.querySelector('#fs-sample');
  if (samplePage && samples.length) {
    const card = samplePage.querySelector('.card');
    if (card) {
      card.querySelectorAll('.rc-row').forEach((r) => r.remove());
      samples.slice(0, 6).forEach((s) => {
        const hl = s.hours_left != null ? parseFloat(s.hours_left) : null;
        const soon = hl != null && hl < 4;
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(s.dish || s.name || '')} · ${esc(s.meal || '')}</div>` +
          `<div class="ds">${esc(s.weight_g || s.weight || '')}g · ${esc(s.keeper || '')} · ${hl != null ? `48h 剩余 ${hl}h` : esc(s.kept_at || s.date || '')}</div></div>` +
          `<span class="tag ${soon ? 'warn' : 'ok'}">${soon ? '将到期' : '留样'}</span>`;
        card.appendChild(row);
      });
    }
  }

  const disCard = findCardIn('#fs-disinfect', '消毒记录');
  if (disCard && disinfect.length) {
    disCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    disinfect.slice(0, 8).forEach((d) => {
      const st = d.status || '已完成';
      const div = document.createElement('div');
      div.className = 'stat-line';
      div.innerHTML =
        `<span>${esc(d.area || d.target || d.name || '区域')}${d.method ? ' · ' + esc(d.method) : ''}</span>` +
        `<span class="tag ${/待|未|漏/.test(String(st)) ? 'warn' : 'ok'}">${esc(String(d.time || d.ts || '').slice(5, 16))} ${esc(st)}</span>`;
      disCard.appendChild(div);
    });
  }
}

/* ---------- 设备能耗 ---------- */

function applyEquipmentApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-equipment', false, '无快照');
    return;
  }
  const temps = arrOf(j, 'temps');
  const maintain = arrOf(j, 'maintain');
  const energy = arrOf(j, 'energy');
  const summary = j.energy_summary && typeof j.energy_summary === 'object' ? j.energy_summary : null;
  const mockTemps = !!j.mock_temps;
  const live = !mockTemps || maintain.length > 0 || energy.length > 0;
  markModuleHead('p-m-equipment', live, live ? 'BFF' : '演示');

  // 温度：mock_temps 时保留原型（原型即"冷柜B超温"演示，与预警跳转落点一致）
  const tempCard = findCardIn('#eq-temp', '冷柜温度');
  if (tempCard && !mockTemps && temps.length) {
    tempCard.querySelectorAll('.stat-line, .alert').forEach((r) => r.remove());
    temps.slice(0, 6).forEach((t) => {
      const over = t.status === 'over';
      const div = document.createElement('div');
      div.className = 'stat-line';
      div.innerHTML =
        `<span>${esc(t.device)} (${esc(t.kind)})</span>` +
        `<span class="tag ${over ? 'danger' : 'ok'}">${esc(t.temp)}℃${over ? ' · 超温' : ''}</span>`;
      tempCard.appendChild(div);
    });
    temps
      .filter((t) => t.status === 'over')
      .forEach((t) => {
        const div = document.createElement('div');
        div.className = 'alert';
        div.style.cursor = 'pointer';
        div.innerHTML =
          `<div class="st" style="background:#E8584A"></div>` +
          `<div class="ct"><div class="t2">${esc(t.device)} 超温${t.minutes != null ? ' ' + esc(t.minutes) + ' 分钟' : ''}</div>` +
          `<div class="d2">应 ≤${esc(t.max)}℃ · 当前 ${esc(t.temp)}℃ · 请立即核查</div></div>`;
        div.onclick = () => {
          if (typeof window.goModule === 'function') window.goModule('loss');
        };
        tempCard.appendChild(div);
      });
    const dev = temps.find((t) => t.status === 'over') || temps[0];
    const curveCard = findCardIn('#eq-temp', '温度曲线');
    if (curveCard && dev && Array.isArray(dev.history) && dev.history.length > 1) {
      const ttl = curveCard.querySelector('.card-h .ttl');
      if (ttl) ttl.innerHTML = `<i class="em"></i>${esc(dev.device)} 温度曲线`;
      const path = curveCard.querySelector('svg.spark path');
      const d = sparkPath(dev.history, 320, 50, 4);
      if (path && d) {
        path.setAttribute('d', d);
        path.setAttribute('stroke', dev.status === 'over' ? '#E8584A' : '#5BA85B');
      }
      const legend = curveCard.querySelector('.legend');
      if (legend) {
        legend.innerHTML = `<span><i style="background:${dev.status === 'over' ? '#E8584A' : '#5BA85B'}"></i>${dev.status === 'over' ? '超温' : '正常'} · 当前 ${esc(dev.temp)}℃ / 上限 ${esc(dev.max)}℃</span>`;
      }
    }
  }

  // 能耗：summary.mock 时保留原型
  if (summary && !summary.mock) {
    const eCard = findCardIn('#eq-energy', '能耗费用');
    if (eCard && Array.isArray(summary.items) && summary.items.length) {
      eCard.querySelectorAll('.fb-row').forEach((r) => r.remove());
      summary.items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'fb-row';
        row.innerHTML =
          `<div class="lb">${esc(it.kind)}</div>` +
          `<div class="fb-bar"><i style="width:${Math.min(100, parseInt(it.pct, 10) || 0)}%;background:linear-gradient(90deg,#F2B233,#E8920C)"></i></div>` +
          `<div class="vl">${esc(fmtMoney(it.amount))}</div>`;
        eCard.appendChild(row);
      });
      const totalRow = document.createElement('div');
      totalRow.className = 'fb-row';
      totalRow.innerHTML = `<div class="lb">合计</div><div class="fb-bar"><i style="width:80%;background:linear-gradient(90deg,#5BA85B,#3a8a3a)"></i></div><div class="vl">${esc(fmtMoney(summary.total))}</div>`;
      eCard.appendChild(totalRow);
    }
    const yoyCard = findCardIn('#eq-energy', '同比环比');
    if (yoyCard) {
      yoyCard.querySelectorAll('.stat-line, .empty-hint').forEach((r) => r.remove());
      [
        ['能耗费用同比', summary.yoy],
        ['能耗费用环比', summary.mom],
        ['营收能耗比', summary.ratio],
      ]
        .filter(([, v]) => v != null)
        .forEach(([k, v]) => {
          const div = document.createElement('div');
          div.className = 'stat-line';
          div.innerHTML = `<span>${esc(k)}</span><span style="color:var(--sub)">${esc(v)}</span>`;
          yoyCard.appendChild(div);
        });
      if (!yoyCard.querySelector('.stat-line')) yoyCard.insertAdjacentHTML('beforeend', emptyStateHtml('暂无同环比数据'));
    }
  }

  const mCard = findCardIn('#eq-maintain', '维保');
  if (mCard) {
    mCard.querySelectorAll('.rc-row, .empty-hint').forEach((r) => r.remove());
    if (maintain.length) {
      const badge = mCard.querySelector('.badge');
      const due = maintain.filter((m) => /待|超|到期/.test(String(m.status || ''))).length;
      if (badge) badge.textContent = String(due || maintain.length);
      maintain.slice(0, 8).forEach((m) => {
        const st = m.status || '正常';
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML =
          `<div class="info"><div class="ti">${esc(m.device || m.name || '设备')} · ${esc(m.item || m.part || m.task || m.kind || '维保')}</div>` +
          `<div class="ds">${esc(m.note || (m.cycle_days ? `周期 ${m.cycle_days} 天` : '') || (m.operator ? `经手 ${m.operator}` : '') || m.date || m.ts || '')}</div></div>` +
          `<span class="tag ${/待|超|到期/.test(String(st)) ? 'warn' : 'ok'}">${esc(st)}</span>`;
        mCard.appendChild(row);
      });
    } else if (live) {
      mCard.insertAdjacentHTML('beforeend', emptyStateHtml('暂无维保到期记录'));
    }
  }
}

/* ---------- 财务税务 ---------- */

function applyFinanceApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-finance', false, '无快照');
    return;
  }
  const invoices = arrOf(j, 'invoices');
  const tax = arrOf(j, 'tax');
  const cash = arrOf(j, 'cash');
  const split = arrOf(j, 'split');
  const recon = j.recon && typeof j.recon === 'object' ? j.recon : null;
  const hasRecon = !!(
    recon &&
    ((recon.dine_in && recon.dine_in.count) || (recon.takeout && recon.takeout.count) || (recon.purchase && recon.purchase.count))
  );
  const live = invoices.length + tax.length + cash.length + split.length > 0 || hasRecon;
  markModuleHead('p-m-finance', live, live ? 'BFF' : '演示');
  if (!live) return;

  const invCard = findCardIn('#fin-invoice', '近期开票');
  if (invCard && invoices.length) {
    invCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    invoices.slice(0, 8).forEach((v) => {
      const st = v.status || '已开';
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(fmtMoney(v.amount))} · ${esc(v.party || v.title || v.buyer || v.invoice_no || '')}</div>` +
        `<div class="ds">${esc(v.type || v.kind || '发票')}${v.direction ? ' · ' + esc(v.direction) : ''} · ${esc(v.date || v.ts || '')}</div></div>` +
        `<span class="tag ${/待|未/.test(String(st)) ? 'warn' : 'ok'}">${esc(st)}</span>`;
      invCard.appendChild(row);
    });
  }

  const taxCard = findCardIn('#fin-tax', '税务预估');
  if (taxCard && tax.length) {
    taxCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    const note = taxCard.querySelector('.note');
    tax.slice(0, 8).forEach((t) => {
      const label = t.item || t.label || t.kind || '税项';
      const isTotal = /合计|总计/.test(String(label));
      const div = document.createElement('div');
      div.className = 'stat-line';
      div.innerHTML =
        `<span>${esc(label)}</span>` +
        `<span style="${isTotal ? 'color:var(--red);font-weight:800' : ''}"><b>${esc(fmtMoney(t.amount))}</b></span>`;
      if (note) taxCard.insertBefore(div, note);
      else taxCard.appendChild(div);
    });
  }

  // 现金流：今日三方勾兑卡（recon）插到首位 + 现金流水
  const cashPage = document.getElementById('fin-cash');
  if (cashPage && recon) {
    let rCard = document.getElementById('bffFinRecon');
    if (!rCard) {
      rCard = document.createElement('div');
      rCard.className = 'card';
      rCard.id = 'bffFinRecon';
      cashPage.insertBefore(rCard, cashPage.firstChild);
    }
    const gap = parseFloat(recon.gap);
    rCard.innerHTML =
      `<div class="card-h"><div class="ttl"><i class="em"></i>今日三方勾兑 · ${esc(recon.date || todayStr())}</div>` +
      `<span class="tag ${recon.confirmed ? 'ok' : 'warn'}">${recon.confirmed ? '已勾兑' : '待确认'}</span></div>` +
      `<div class="stat-line"><span>堂食营收</span><span><b>${esc(fmtMoney(recon.dine_in?.amount))}</b> · ${recon.dine_in?.count ?? 0} 单</span></div>` +
      `<div class="stat-line"><span>外卖营收</span><span><b>${esc(fmtMoney(recon.takeout?.amount))}</b> · ${recon.takeout?.count ?? 0} 单</span></div>` +
      `<div class="stat-line"><span>采购支出</span><span><b>${esc(fmtMoney(recon.purchase?.amount))}</b> · ${recon.purchase?.count ?? 0} 单</span></div>` +
      `<div class="stat-line"><span>进销差额</span><span style="font-weight:800;color:${!isNaN(gap) && gap < 0 ? 'var(--red)' : 'var(--green)'}">${esc(fmtMoney(recon.gap))}</span></div>` +
      cash
        .slice(0, 5)
        .map(
          (c) =>
            `<div class="stat-line"><span>${esc(c.kind || '流水')} ${esc(String(c.ts || c.date || '').slice(5, 16))}</span><span>${esc(fmtMoney(c.amount))}${c.note ? ' · ' + esc(String(c.note).slice(0, 16)) : ''}</span></div>`,
        )
        .join('');
  }

  // 分账
  if (split.length) {
    const donutCard = findCardIn('#fin-split', '股东分账');
    if (donutCard) {
      const colors = ['#9B6BBF', '#F48FB1', '#5BA85B', '#F2B233'];
      const leg = donutCard.querySelector('.donut-leg');
      if (leg) {
        leg.innerHTML = split
          .slice(0, 4)
          .map(
            (s, i) =>
              `<div class="li"><span><i style="background:${colors[i % colors.length]}"></i>${esc(s.name || s.party || '股东')} ${esc(s.ratio ?? s.pct ?? '')}${s.ratio != null || s.pct != null ? '%' : ''}</span></div>`,
          )
          .join('');
      }
      const hole = donutCard.querySelector('.donut .pct');
      if (hole) hole.textContent = `${split.length}人`;
      const stops = [];
      let acc = 0;
      split.slice(0, 4).forEach((s, i) => {
        const p = parseFloat(s.ratio ?? s.pct) || 0;
        stops.push(`${colors[i % colors.length]} ${acc}% ${acc + p}%`);
        acc += p;
      });
      const donut = donutCard.querySelector('.donut');
      if (donut && stops.length && acc > 0) donut.style.background = `conic-gradient(${stops.join(',')})`;
    }
    const profitCard = findCardIn('#fin-split', '可分利润');
    if (profitCard) {
      profitCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
      const note = profitCard.querySelector('.note');
      split.slice(0, 6).forEach((s) => {
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML =
          `<span>${esc(s.name || s.party || '股东')} ${s.ratio ?? s.pct ?? ''}%</span>` +
          `<span class="up">${esc(fmtMoney(s.amount))}</span>`;
        if (note) profitCard.insertBefore(div, note);
        else profitCard.appendChild(div);
      });
    }
  }
}

/* ---------- 供应链 ---------- */

function applySupplyApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-supply', false, '无快照');
    return;
  }
  const vendors = arrOf(j, 'vendors');
  const quotes = arrOf(j, 'quotes');
  const accounts = arrOf(j, 'accounts');
  const live = vendors.length + quotes.length > 0;
  markModuleHead('p-m-supply', live, live ? 'BFF' : '演示');
  if (!live) return;

  const vCard = findCardIn('#sup-vendor', '供应商档案');
  if (vCard && vendors.length) {
    vCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    const more = vCard.querySelector('.card-h .more');
    if (more) more.textContent = `${vendors.length} 家`;
    vendors.slice(0, 8).forEach((v) => {
      const name = typeof v === 'string' ? v : v.name || v.id || '供应商';
      const lvl = parseInt(typeof v === 'object' && v ? v.level : NaN, 10);
      const stars =
        !isNaN(lvl) && lvl > 0
          ? '★'.repeat(Math.min(5, lvl)) + `<span class="e">${'★'.repeat(Math.max(0, 5 - Math.min(5, lvl)))}</span>`
          : `<span class="e">★★★★★</span>`;
      const ds = typeof v === 'object' && v ? [v.category, v.period || v.status].filter(Boolean).join(' · ') : '';
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML = `<div class="info"><div class="ti">${esc(name)}</div><div class="ds">${esc(ds)}</div></div><span class="stars">${stars}</span>`;
      vCard.appendChild(row);
    });
  }

  // 比价：按原料分组，取报价最多的一组
  const cmpCard = document.querySelector('#sup-compare .card');
  if (cmpCard && !quotes.length) {
    cmpCard.querySelectorAll('.kv, .empty-hint').forEach((r) => r.remove());
    const note = cmpCard.querySelector('.note');
    const div = document.createElement('div');
    div.innerHTML = emptyStateHtml('暂无报价数据（快照 quotes 为空）');
    if (note) cmpCard.insertBefore(div.firstChild, note);
    else cmpCard.appendChild(div.firstChild);
  }
  if (cmpCard && quotes.length) {
    const byIng = {};
    quotes.forEach((q) => {
      const ing = q.ing || q.name || q.item || q.ingredient || '原料';
      if (!byIng[ing]) byIng[ing] = [];
      byIng[ing].push(q);
    });
    const ings = Object.keys(byIng).sort((a, b) => byIng[b].length - byIng[a].length);
    const ing = ings[0];
    const list = (byIng[ing] || []).filter((q) => !isNaN(parseFloat(q.price)));
    if (ing && list.length) {
      const ttl = cmpCard.querySelector('.card-h .ttl');
      if (ttl) ttl.innerHTML = `<i class="em"></i>${esc(ing)} 比价 · ${list.length} 家`;
      cmpCard.querySelectorAll('.kv').forEach((r) => r.remove());
      const note = cmpCard.querySelector('.note');
      list.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      list.slice(0, 6).forEach((q, i) => {
        const div = document.createElement('div');
        div.className = 'kv';
        div.innerHTML = `<span>${esc(q.src || q.supplier || q.vendor || '供应商')}${i === 0 ? ' (最低)' : ''}</span><b>${esc(fmtMoney(q.price))}${q.unit ? '/' + esc(q.unit) : ''}</b>`;
        if (note) cmpCard.insertBefore(div, note);
        else cmpCard.appendChild(div);
      });
      if (note && list.length > 1) {
        const save = parseFloat(list[list.length - 1].price) - parseFloat(list[0].price);
        note.innerHTML = `建议：${esc(list[0].src || list[0].supplier || '最低价供应商')} 最低，比最高省 ${esc(fmtMoney(save))}${list[0].unit ? '/' + esc(list[0].unit) : ''}。AI 仅建议，不自动切换供应商。`;
      }
    }
  }

  const accCard = findCardIn('#sup-account', '合同账期');
  if (accCard && !accounts.length) {
    accCard.querySelectorAll('.stat-line, .empty-hint').forEach((r) => r.remove());
    accCard.insertAdjacentHTML('beforeend', emptyStateHtml('暂无账期/应付数据（快照 accounts 为空）'));
  }
  if (accCard && accounts.length) {
    accCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
    accounts.slice(0, 8).forEach((a) => {
      const div = document.createElement('div');
      div.className = 'stat-line';
      div.innerHTML = `<span>${esc(a.supplier || a.name || '供应商')}</span><span>${esc(a.period || a.status || '')}</span>`;
      accCard.appendChild(div);
    });
    const ageCard = findCardIn('#sup-account', '应付账龄');
    if (ageCard) {
      ageCard.querySelectorAll('.fb-row, .empty-hint').forEach((r) => r.remove());
      const withBal = accounts.filter((a) => !isNaN(parseFloat(a.balance)));
      const max = Math.max(...withBal.map((a) => parseFloat(a.balance)), 1);
      withBal.slice(0, 6).forEach((a) => {
        const bal = parseFloat(a.balance);
        const pct = Math.min(100, Math.round((bal / max) * 100));
        const overdue = /逾期|超/.test(String(a.status || ''));
        const row = document.createElement('div');
        row.className = 'fb-row';
        row.innerHTML =
          `<div class="lb">${esc(String(a.supplier || a.name || '').slice(0, 6))}</div>` +
          `<div class="fb-bar"><i style="width:${pct}%;background:linear-gradient(90deg,${overdue ? '#E8584A,#a83028' : '#5BA85B,#3a8a3a'})"></i></div>` +
          `<div class="vl">${esc(fmtMoney(bal))}</div>`;
        ageCard.appendChild(row);
      });
      if (!withBal.length) ageCard.insertAdjacentHTML('beforeend', emptyStateHtml('暂无应付余额数据'));
    }
  }
}

/* ---------- 顾客口碑 ---------- */

function applyReviewApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-review', false, '无快照');
    return;
  }
  const reviews = arrOf(j, 'reviews');
  const improve = arrOf(j, 'improve');
  const live = reviews.length + improve.length > 0;
  markModuleHead('p-m-review', live, live ? 'BFF' : '演示');
  if (!live) return;

  const rating = (r) => parseFloat(r.rating ?? r.score ?? r.stars);
  if (reviews.length) {
    const rated = reviews.filter((r) => !isNaN(rating(r)));
    const avg = rated.length ? rated.reduce((s, r) => s + rating(r), 0) / rated.length : null;
    const banner = document.querySelector('#rv-score .sum-banner');
    if (banner && avg != null) {
      const val = banner.querySelector('.sb-val');
      const dlt = banner.querySelector('.sb-delta');
      if (val) val.innerHTML = `${avg.toFixed(1)} <small>/5.0</small>`;
      if (dlt) dlt.textContent = `共 ${reviews.length} 条 | rev ${esc(j.rev ?? '—')}`;
    }
    const platCard = findCardIn('#rv-score', '平台评分');
    if (platCard) {
      const byPlat = {};
      rated.forEach((r) => {
        const p = r.platform || r.source || '综合';
        if (!byPlat[p]) byPlat[p] = { sum: 0, n: 0 };
        byPlat[p].sum += rating(r);
        byPlat[p].n += 1;
      });
      const keys = Object.keys(byPlat);
      if (keys.length) {
        platCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
        keys.slice(0, 6).forEach((p) => {
          const div = document.createElement('div');
          div.className = 'stat-line';
          div.innerHTML = `<span>${esc(p)}</span><span><b>${(byPlat[p].sum / byPlat[p].n).toFixed(1)}</b> · ${byPlat[p].n} 条</span>`;
          platCard.appendChild(div);
        });
      }
    }
  }

  const impCard = findCardIn('#rv-improve', '差评改进闭环');
  if (impCard && improve.length) {
    impCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    const badge = impCard.querySelector('.badge');
    const open = improve.filter((i) => !/闭环|完成|已解决/.test(String(i.status || ''))).length;
    if (badge) badge.textContent = String(open || improve.length);
    improve.slice(0, 6).forEach((i) => {
      const st = i.status || '跟进';
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">"${esc(String(i.issue || i.title || i.content || i.action || '差评').slice(0, 18))}" · ${esc(i.platform || i.owner || '')}</div>` +
        `<div class="ds">${esc(String(i.reason || i.note || i.action || '').slice(0, 40))}</div></div>` +
        `<span class="tag ${/闭环|完成|已解决/.test(String(st)) ? 'ok' : 'warn'}">${esc(st)}</span>`;
      impCard.appendChild(row);
    });
    const actCard = findCardIn('#rv-improve', '改进措施');
    if (actCard) {
      actCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
      improve
        .filter((i) => i.measure || i.action)
        .slice(0, 5)
        .forEach((i) => {
          const div = document.createElement('div');
          div.className = 'stat-line';
          div.innerHTML = `<span>${esc(String(i.issue || i.title || '').slice(0, 14))}</span><span class="tag ok">${esc(String(i.measure || i.action).slice(0, 16))}</span>`;
          actCard.appendChild(div);
        });
    }
  }

  const goodCard = findCardIn('#rv-good', '好评精选');
  if (goodCard && reviews.length) {
    const goods = reviews.filter((r) => (rating(r) || 0) >= 4 && (r.content || r.text || r.comment)).slice(0, 4);
    if (goods.length) {
      goodCard.querySelectorAll('.note').forEach((n) => n.remove());
      goods.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'note';
        div.style.cssText = `background:#F8F9FB;border-left:3px solid #5BA85B${i ? ';margin-top:8px' : ''}`;
        div.textContent = `"${String(r.content || r.text || r.comment).slice(0, 60)}" — ${r.platform || '顾客'}${r.user ? ' ' + r.user : ''}${r.ts || r.date ? ' ' + String(r.ts || r.date).slice(5, 10) : ''}`;
        goodCard.appendChild(div);
      });
    }
  }
}

/* ---------- 损耗报损 ---------- */

function applyLossApi(j) {
  if (isNoSnap(j)) {
    markModuleHead('p-m-loss', false, '无快照');
    return;
  }
  const reports = arrOf(j, 'reports');
  markModuleHead('p-m-loss', reports.length > 0, reports.length ? 'BFF' : '演示');
  if (!reports.length) return;

  const amt = (r) => parseFloat(r.amount ?? r.value ?? r.cost) || 0;
  const nameOf = (r) => r.name || r.ing || r.ing_name || r.ingredient || '原料';
  const total = reports.reduce((s, r) => s + amt(r), 0);

  const banner = document.querySelector('#ls-analysis .sum-banner');
  if (banner) {
    const val = banner.querySelector('.sb-val');
    const dlt = banner.querySelector('.sb-delta');
    if (val) val.innerHTML = `${esc(fmtMoney(total))} <small>· ${reports.length} 单</small>`;
    if (dlt) dlt.textContent = `BFF 报损单合计 | rev ${esc(j.rev ?? '—')}`;
  }

  const ingCard = findCardIn('#ls-analysis', '按原料损耗');
  if (ingCard) {
    const byIng = {};
    reports.forEach((r) => {
      const n = nameOf(r);
      byIng[n] = (byIng[n] || 0) + amt(r);
    });
    const keys = Object.keys(byIng)
      .sort((a, b) => byIng[b] - byIng[a])
      .slice(0, 6);
    if (keys.length) {
      ingCard.querySelectorAll('.fb-row').forEach((r) => r.remove());
      const max = Math.max(...keys.map((k) => byIng[k]), 1);
      const colors = ['#E8584A,#a83028', '#9B6BBF,#7a5aa3', '#F48FB1,#9B6BBF', '#5BA85B,#3a8a3a', '#F2B233,#E8920C', '#87CEEB,#3A6EA5'];
      keys.forEach((k, i) => {
        const row = document.createElement('div');
        row.className = 'fb-row';
        row.innerHTML =
          `<div class="lb">${esc(k)}</div>` +
          `<div class="fb-bar"><i style="width:${Math.round((byIng[k] / max) * 100)}%;background:linear-gradient(90deg,${colors[i % colors.length]})"></i></div>` +
          `<div class="vl">${esc(fmtMoney(byIng[k]))}</div>`;
        ingCard.appendChild(row);
      });
    }
  }

  const reasonCard = findCardIn('#ls-analysis', '损耗原因');
  if (reasonCard) {
    const byReason = {};
    reports.forEach((r) => {
      const k = r.reason || '其他';
      byReason[k] = (byReason[k] || 0) + amt(r);
    });
    const keys = Object.keys(byReason)
      .sort((a, b) => byReason[b] - byReason[a])
      .slice(0, 4);
    if (keys.length) {
      const leg = reasonCard.querySelector('.donut-leg');
      const colors = ['#E8584A', '#F2B233', '#9B6BBF', '#5BA85B'];
      if (leg) {
        leg.innerHTML = keys
          .map(
            (k, i) =>
              `<div class="li"><span><i style="background:${colors[i % colors.length]}"></i>${esc(k)} ${Math.round((byReason[k] / (total || 1)) * 100)}%</span></div>`,
          )
          .join('');
      }
      const hole = reasonCard.querySelector('.donut .pct');
      if (hole) hole.textContent = total >= 1000 ? `¥${(total / 1000).toFixed(1)}k` : fmtMoney(total);
    }
  }

  const repCard = findCardIn('#ls-report', '报损单审批');
  if (repCard) {
    repCard.querySelectorAll('.rc-row').forEach((r) => r.remove());
    const pending = reports.filter((r) => /待|草稿|审批中/.test(String(r.status || ''))).length;
    const badge = repCard.querySelector('.badge');
    if (badge) badge.textContent = String(pending);
    reports.slice(0, 8).forEach((r) => {
      const st = r.status || '待审批';
      const act = /待|草稿|审批中/.test(String(st))
        ? `<button class="pbtn" onclick="openSheet('confirm')">审批</button>`
        : `<span class="tag ok">${esc(st)}</span>`;
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML =
        `<div class="info"><div class="ti">${esc(nameOf(r))} · ${esc(r.reason || '')} ${r.qty != null ? esc(String(r.qty) + (r.unit || '')) : ''}</div>` +
        `<div class="ds">金额 ${esc(fmtMoney(amt(r)))}${r.date || r.ts ? ' · ' + esc(String(r.date || r.ts).slice(0, 10)) : ''}</div></div>${act}`;
      repCard.appendChild(row);
    });
  }

  const invCard = findCardIn('#ls-inventory', '盘点差异');
  if (invCard) {
    const counts = reports.filter((r) => /盘/.test(String(r.kind || r.type || r.reason || '')));
    if (counts.length) {
      invCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
      counts.slice(0, 6).forEach((r) => {
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML =
          `<span>${esc(nameOf(r))} · ${esc(r.reason || r.kind || '')}</span>` +
          `<span class="down">${r.qty != null ? esc(String(r.qty) + (r.unit || '')) : ''} · ${esc(fmtMoney(amt(r)))}</span>`;
        invCard.appendChild(div);
      });
    }
  }
}

/* ---------- 厨房深页（board / workorders / qc） ---------- */

function applyKitchenApi(boardJ, woJ, qcJ) {
  const noSnapAll = [boardJ, woJ, qcJ].every((j) => isNoSnap(j));
  if (noSnapAll) {
    markModuleHead('p-kitchen', false, '无快照');
    return;
  }
  const board = boardJ && !boardJ.__err ? arrOf(boardJ, 'board') : [];
  const tables = boardJ && !boardJ.__err ? arrOf(boardJ, 'tables') : [];
  const demand = boardJ && !boardJ.__err && boardJ.demand ? boardJ.demand : null;
  const wos = woJ && !woJ.__err ? arrOf(woJ, 'workorders') : [];
  const qcs = qcJ && !qcJ.__err ? arrOf(qcJ, 'items') : [];
  const live = board.length + wos.length + qcs.length > 0;
  markModuleHead('p-kitchen', live, live ? 'BFF' : '演示');
  if (!live) return;

  // kt-board 出品看板
  const boardCard = findCardIn('#kt-board', '今日出品');
  if (boardCard && board.length) {
    boardCard.querySelectorAll('.ob-row').forEach((r) => r.remove());
    const fresh = boardCard.querySelector('.fresh');
    if (fresh) fresh.innerHTML = `<i class="dot"></i>rev ${esc(boardJ.rev ?? '—')}`;
    const barColor = { 红: '#E8584A', 黑: '#3a3a3a', 黄: '#F2B233', 绿: '#5BA85B', 紫: '#9B6BBF', 白: '#888' };
    board.slice(0, 8).forEach((g) => {
      const ch = String(g.color || '?').charAt(0);
      const pct = g.planned ? Math.min(100, Math.round(((g.done || 0) / g.planned) * 100)) : 0;
      const row = document.createElement('div');
      row.className = 'ob-row';
      row.innerHTML =
        `<div class="nm"><span class="dot5 ${WUFU_DOT[ch] || ''}" style="display:inline-flex;width:20px;height:20px;font-size:11px;margin-right:6px">${esc(ch)}</span>${esc(g.color)}${g.qc_pass_rate != null ? ` · QC ${Math.round(g.qc_pass_rate * 100)}%` : ''}</div>` +
        `<div class="pr"><div class="top"><b>${g.done || 0}</b>/${g.planned || 0}</div>` +
        `<div class="track"><i style="width:${pct}%;background:${barColor[ch] || '#3A6EA5'}"></i></div></div>`;
      boardCard.appendChild(row);
    });
    boardCard.querySelectorAll('.bff-board-note').forEach((n) => n.remove());
    if (tables.length || demand) {
      const bits = [];
      if (tables.length) bits.push(`传菜对桌 ${tables.length} 桌（待出 ${tables.reduce((s, t) => s + (t.pending || 0), 0)} 份）`);
      if (demand) bits.push(`本餐需求约 ${demand.suggest_portions ?? '—'} 份 · 已建工单 ${demand.workorder_planned ?? 0} 份 · 缺口 ${demand.gap ?? 0} 份`);
      const div = document.createElement('div');
      div.className = 'note bff-board-note';
      div.style.marginTop = '8px';
      div.textContent = bits.join(' | ');
      boardCard.appendChild(div);
    }
  }

  // kt-sop 工单
  const sopPage = document.getElementById('kt-sop');
  if (sopPage && wos.length) {
    const cards = sopPage.querySelectorAll('.card');
    const mainCard = cards[0];
    const otherCard = cards[1];
    const w0 = wos[0];
    if (mainCard) {
      const ttl = mainCard.querySelector('.card-h .ttl');
      if (ttl) ttl.innerHTML = `<i class="em"></i>${esc(w0.name || w0.sku_id || '工单')} · 工单`;
      const tag = mainCard.querySelector('.card-h .tag');
      if (tag) {
        tag.textContent = w0.status || '进行中';
        tag.className = 'tag ' + (/完成/.test(String(w0.status)) ? 'ok' : 'warn');
      }
      const timeline = mainCard.querySelector('.timeline');
      if (timeline) {
        timeline.querySelectorAll('.tl-step').forEach((s) => s.remove());
        const steps = Array.isArray(w0.steps) ? w0.steps : [];
        if (steps.length) {
          steps.forEach((st, i) => {
            const div = document.createElement('div');
            div.className = 'tl-step' + (/完成/.test(String(w0.status)) ? ' done' : i === 0 ? ' now' : '');
            div.innerHTML =
              `<div class="tl-time">#${esc(st.step_no ?? i + 1)}</div>` +
              `<div class="tl-ti">${esc(st.stage || st.name || `步骤 ${st.step_no ?? i + 1}`)}${st.duration_min ? ` · ${esc(st.duration_min)} 分钟` : ''}</div>` +
              `<div class="tl-ds">${esc(st.key_points || st.inputs || st.params || '')}</div>` +
              (st.qc_point ? `<span class="tl-qc">QC ${esc(st.qc_point)}</span>` : '');
            timeline.appendChild(div);
          });
        } else {
          timeline.insertAdjacentHTML(
            'afterbegin',
            `<div class="tl-step now"><div class="tl-time">${esc(String(w0.planned_start || '').slice(11, 16) || '—')}</div>` +
              `<div class="tl-ti">工单 ${esc(w0.id)}</div><div class="tl-ds">数量 ${esc(w0.qty ?? '—')} 份 | 状态 ${esc(w0.status || '')}</div></div>`,
          );
        }
      }
    }
    if (otherCard) {
      otherCard.querySelectorAll('.stat-line, .empty-hint').forEach((r) => r.remove());
      const rest = wos.slice(1, 6);
      if (rest.length) {
        rest.forEach((w) => {
          const div = document.createElement('div');
          div.className = 'stat-line';
          div.innerHTML =
            `<span>${esc(w.name || w.sku_id || '工单')}</span>` +
            `<span style="color:var(--sub)">${esc(String(w.planned_start || '').slice(11, 16))} · ${esc(w.qty ?? '—')} 份 · ${esc(w.status || '')}</span>`;
          otherCard.appendChild(div);
        });
      } else {
        otherCard.insertAdjacentHTML('beforeend', emptyStateHtml('今日仅 1 张工单'));
      }
    }
  }

  // kt-qc 品控
  const qcPage = document.getElementById('kt-qc');
  if (qcPage && qcs.length) {
    const statCard = findCardIn('#kt-qc', '抽查');
    if (statCard) {
      statCard.querySelectorAll('.stat-line').forEach((r) => r.remove());
      const isPass = (q) => q.pass === true || q.pass === 1 || q.pass === 'true' || q.pass === 'pass';
      const passN = qcs.filter(isPass).length;
      const head = document.createElement('div');
      head.className = 'stat-line';
      head.innerHTML = `<span>今日品控记录</span><span><b>${qcs.length}</b> 条 · 合格 ${Math.round((passN / qcs.length) * 100)}%</span>`;
      statCard.appendChild(head);
      qcs.slice(0, 5).forEach((q) => {
        const div = document.createElement('div');
        div.className = 'stat-line';
        div.innerHTML =
          `<span>${esc(q.name || q.sku_id || '品控')}${q.sample_weight != null ? ` · ${esc(q.sample_weight)}g` : ''}</span>` +
          `<span class="tag ${isPass(q) ? 'ok' : 'warn'}">${isPass(q) ? '合格' : '待复核'} ${esc(String(q.ts || '').slice(11, 16))}</span>`;
        statCard.appendChild(div);
      });
    }
  }
}

/* ---------- 并行拉取 + 逐页应用 ---------- */

async function hydrateModules() {
  const today = encodeURIComponent(todayStr());
  const jobs = [
    ['analysis', '/api/modules/analysis'],
    ['staff', '/api/modules/staff'],
    ['booking', `/api/modules/booking?date=${today}`],
    ['foodsafe', '/api/modules/foodsafe'],
    ['vip', '/api/modules/vip'],
    ['takeout', '/api/modules/takeout'],
    ['review', '/api/modules/review'],
    ['equipment', '/api/modules/equipment'],
    ['finance', '/api/modules/finance'],
    ['loss', '/api/modules/loss'],
    ['supply', '/api/modules/supply'],
    ['restock', '/api/inventory/restock-suggest'],
    ['ktBoard', `/api/kitchen/board?date=${today}`],
    ['ktWo', `/api/kitchen/workorders?date=${today}`],
    ['ktQc', `/api/kitchen/qc?date=${today}`],
  ];
  const settled = await Promise.allSettled(jobs.map(([, url]) => api(url)));
  const out = {};
  settled.forEach((r, i) => {
    out[jobs[i][0]] = r.status === 'fulfilled' ? r.value : { __err: r.reason };
  });

  const appliers = [
    ['analysis', () => applyAnalysisApi(out.analysis)],
    ['staff', () => applyStaffApi(out.staff)],
    ['booking', () => applyBookingApi(out.booking)],
    ['foodsafe', () => applyFoodsafeApi(out.foodsafe)],
    ['vip', () => applyVipApi(out.vip)],
    ['takeout', () => applyTakeoutApi(out.takeout)],
    ['review', () => applyReviewApi(out.review)],
    ['equipment', () => applyEquipmentApi(out.equipment)],
    ['finance', () => applyFinanceApi(out.finance)],
    ['loss', () => applyLossApi(out.loss)],
    ['supply', () => applySupplyApi(out.supply)],
    ['restock', () => applyRestockSuggest(out.restock)],
    ['kitchen', () => applyKitchenApi(out.ktBoard, out.ktWo, out.ktQc)],
  ];
  appliers.forEach(([name, fn]) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[boss-app] module hydrate failed: ${name}`, e);
    }
  });
  return out;
}

/* ---------------- 刷新 / 写回 / 对话 ---------------- */

async function pullReportSnapshotModules(state) {
  try {
    const report = await api(`/api/report/daily?date=${encodeURIComponent(todayStr())}`);
    state.report = report;
    state.reportOk = applyDailyReport(report) || state.reportOk;
    state.mock = !!report?.mock;
    state.rev = report?.rev ?? state.rev;
  } catch (e) {
    console.warn('[boss-app] daily report hydrate failed', e);
  }

  try {
    const snap = await api('/api/snapshot/latest');
    state.snapOk = applySnapshot(snap, state.report) || state.snapOk;
    state.rev = snap?.rev ?? state.rev;
    if (state.snapOk) state.mock = state.mock && !snap?.data;
  } catch (e) {
    console.warn('[boss-app] snapshot hydrate failed', e);
  }

  try {
    await hydrateModules();
  } catch (e) {
    console.warn('[boss-app] modules hydrate failed', e);
  }
}

export async function refreshFromBff() {
  const state = { report: null, reportOk: false, snapOk: false, mock: true, rev: null };

  try {
    if (!getToken()) await bossLogin();
  } catch (e) {
    console.warn('[boss-app] login failed', e);
    setHydrateStatus({ offline: true, mock: true, snapOk: false, rev: null });
    notifyHydrate('BFF 登录失败，已切换离线原型');
    return { reportOk: false, snapOk: false };
  }

  _api401 = false;
  await pullReportSnapshotModules(state);

  if (_api401) {
    // 401：token 已被 api() 清除，自动重新登录并重试一次
    try {
      await bossLogin();
      _api401 = false;
      await pullReportSnapshotModules(state);
    } catch (e) {
      console.warn('[boss-app] re-login after 401 failed', e);
      setHydrateStatus({ offline: true, mock: true, snapOk: false, rev: null });
      notifyHydrate('登录态失效，重登失败，已切换离线原型');
      return { reportOk: false, snapOk: false };
    }
    if (_api401) {
      setHydrateStatus({ offline: true, mock: true, snapOk: state.snapOk, rev: state.rev });
      notifyHydrate('BFF 鉴权失败（401），请检查服务端');
      return { reportOk: state.reportOk, snapOk: state.snapOk };
    }
  }

  setHydrateStatus({ offline: false, mock: state.mock || !state.snapOk, snapOk: state.snapOk, rev: state.rev });
  return { reportOk: state.reportOk, snapOk: state.snapOk };
}

export async function bossConfirmAction(type, payload, label) {
  const toastFn = typeof window.toast === 'function' ? window.toast : (m) => alert(m);
  try {
    if (!getToken()) await bossLogin();
    const body = {
      type: type || 'boss.confirm',
      payload: payload || {},
      operator: '老板',
    };
    const enq = await api('/api/actions', { method: 'POST', body: JSON.stringify(body) });
    const rev = getRev();
    if (enq?.id) {
      try {
        await api(`/api/actions/${encodeURIComponent(enq.id)}/confirm`, {
          method: 'POST',
          body: JSON.stringify({ operator: '老板', rev: rev != null ? rev : enq.rev }),
        });
      } catch (cf) {
        if (cf.status !== 409) throw cf;
      }
    }
    toastFn(`${label || '已提交'} | 已入队 ${enq?.id || ''}`.trim());
    if (typeof window.closeSheet === 'function') window.closeSheet();
  } catch (e) {
    console.warn('[boss-app] action failed', e);
    toastFn(`${label || '操作'}失败：${e.message || '请检查 BFF'}`);
  }
}

async function bossAsk(question) {
  try {
    if (!getToken()) await bossLogin();
    const j = await api('/api/agent/chat', {
      method: 'POST',
      body: JSON.stringify({ question, ctx: { rev: getRev() } }),
    });
    if (j?.ok) {
      const parts = [];
      if (j.answer) parts.push(j.answer);
      else if (j.note) parts.push(j.note);
      if (Array.isArray(j.suggestions) && j.suggestions.length) {
        parts.push('可继续问：' + j.suggestions.slice(0, 3).join(' / '));
      }
      if (parts.length) return parts.join('<br/>');
    }
  } catch (e) {
    console.warn('[boss-app] agent chat failed', e);
    return `问店暂时不可用（${e.message || '网络错误'}）。可先看进销 Tab 真库存，或稍后重试。`;
  }
  return null;
}

function installChatBridge() {
  const origAsk = window.ask;
  const origSend = window.sendAsk;
  window.sendAsk = async function sendAskBff() {
    const inp = document.getElementById('askInput');
    if (!inp) return;
    const q = inp.value.trim();
    if (!q) return;
    const wrap = document.getElementById('chatWrap');
    const pandaSrc = document.querySelector('.panda-logo')?.src || '';
    wrap.insertAdjacentHTML('beforeend', `<div class="msg me"><div class="who"><b>我</b></div>${esc(q)}</div>`);
    inp.value = '';
    // 每次提问生成唯一 pending id，避免连续提问时 id 重复、替换错节点
    const pendingId = `aiPending-${Date.now()}-${++_aiPendingSeq}`;
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="msg ai" id="${pendingId}"><div class="who"><img class="panda-logo" src="${pandaSrc}" alt=""><b>五福 AI | 思考中</b></div>正在查店内快照…</div>`,
    );
    wrap.scrollTop = wrap.scrollHeight;

    let a = await bossAsk(q);
    if (!a) {
      a =
        (window.aiReply && window.aiReply[q]) ||
        'BFF 未返回答案。可问：补货、营收、菜品、比价；或点预置问题重试。';
    }
    const pending = document.getElementById(pendingId);
    if (pending) {
      pending.outerHTML = `<div class="msg ai"><div class="who"><img class="panda-logo" src="${pandaSrc}" alt=""><b>五福 AI | 在线</b></div>${a}</div>`;
    }
    wrap.scrollTop = wrap.scrollHeight;
  };
  window.ask = function askBff(q) {
    const inp = document.getElementById('askInput');
    if (inp) inp.value = q;
    return window.sendAsk();
  };
  window.__origAsk = origAsk;
  window.__origSendAsk = origSend;
}

export function installBossBff() {
  window.KIMI_BFF_URL = window.KIMI_BFF_URL || '/api/kimi/vision';
  window.__bossBffRefresh = refreshFromBff;
  window.bossConfirmAction = bossConfirmAction;
  window.jumpAlert = jumpAlert;

  const boot = () => {
    ensureDataBadge();
    applyStatusBadge({ offline: false, mock: true, snapOk: false, rev: null });
    installChatBridge();
    loadWufuMenu().then((m) => {
      if (m) renderWufuKitchenMenu(m);
    });
    refreshFromBff().catch(() => {
      setHydrateStatus({ offline: true, mock: true, snapOk: false, rev: null });
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    setTimeout(boot, 0);
  }
}
