#!/usr/bin/env node
'use strict';
/*
 * scripts/gen-progress-board.js — 生成 docs/进度看板.html
 *
 * 目的：提供一种不依赖 AI agent 的进度查询手段。双击 HTML 即可看全盘进度，
 *       不需起服务、不需联网、不需翻文档找数字。
 *
 * 设计原则（沿用本项目既有教训「汇总数是派生数据，必须以行为准」）：
 *   1. 只解析既有文件，不引入任何手工维护的第二状态源；
 *   2. 宁可说「未验证」，不可说「通过」——未跑的门禁一律渲染为未验证；
 *   3. 解析结果与欠账总表不一致时红条告警（两处数字对不上本身就是缺陷）。
 *
 * 用法：
 *   node scripts/gen-progress-board.js            # 生成看板（含漂移校验，不跑构建门禁）
 *   node scripts/gen-progress-board.js --no-drift # 跳过漂移校验
 *   node scripts/gen-progress-board.js --gates    # 额外真跑本机门禁（慢）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const OPT = { drift: ARGV.indexOf('--no-drift') < 0, gates: ARGV.indexOf('--gates') >= 0 };

const DIR_BASE = path.join(ROOT, 'docs', '迁移基线');
const F_DEBT = path.join(DIR_BASE, '欠账总表.md');
const F_TASKS = path.join(ROOT, 'docs', '下一步任务清单_2026-09-28.md');
const DIR_ADR = path.join(ROOT, 'docs', 'decisions');
const F_CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const F_DRIFT = path.join(ROOT, 'scripts', 'gen-debt-table.ps1');
const F_REDLINE_PS1 = path.join(ROOT, 'ci', 'redline_guard.ps1');
const OUT_HTML = path.join(ROOT, 'docs', '进度看板.html');

/* ------------------------------------------------------------------ 工具 */

const readUtf8 = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function mtime(p) { try { return fs.statSync(p).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return '—'; } }
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (s) => String(s == null ? '' : s).replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const pad = (n, w) => ' '.repeat(Math.max(0, w - String(n).length)) + n;
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/** 从 .git 直读当前提交（纯文件读取，不调 git，不联网） */
function gitRev() {
  try {
    const head = readUtf8(path.join(ROOT, '.git', 'HEAD')).trim();
    if (head.indexOf('ref:') !== 0) return head.slice(0, 8);
    const ref = head.slice(4).trim();
    const direct = path.join(ROOT, '.git', ref);
    if (isFile(direct)) return readUtf8(direct).trim().slice(0, 8);
    const packed = path.join(ROOT, '.git', 'packed-refs');
    if (isFile(packed)) {
      const re = new RegExp('^' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([0-9a-f]{7,})', 'm');
      const m = re.exec(readUtf8(packed));
      if (m) return m[1].slice(0, 8);
    }
    return '(未提交)';
  } catch (e) { return '(未知)'; }
}

/* ------------------------------------------------- 解析 1：迁移基线（行标注=权威） */

const ST = {
  up: { glyph: '⬆️', label: '已移植', color: '#16a34a' },
  alt: { glyph: '🔄', label: '等价替代', color: '#0891b2' },
  todo: { glyph: '⬜', label: '待补', color: '#dc2626' },
  dead: { glyph: '⚰️', label: '废弃', color: '#6b7280' },
};
function normState(cell) {
  if (cell.indexOf('⬆️') >= 0) return 'up';
  if (cell.indexOf('🔄') >= 0) return 'alt';
  if (cell.indexOf('⚰️') >= 0) return 'dead';
  if (cell.indexOf('⬜') >= 0) return 'todo';
  return null;
}

function parseBaselines() {
  const files = fs.readdirSync(DIR_BASE).filter((f) => /^FP-.*\.md$/.test(f)).sort();
  const pages = [];
  for (const f of files) {
    const lines = readUtf8(path.join(DIR_BASE, f)).split(/\r?\n/);
    const h1 = lines.find((l) => /^#\s*迁移基线/.test(l)) || '';
    const mt = /^#\s*迁移基线\s*[·:：]\s*(.+?)\s*[（(]/.exec(h1);
    const name = mt ? mt[1].trim() : f.replace(/^FP-/, '').replace(/\.md$/, '');
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\|\s*FP-[A-Z]+-\d+\s*\|/.test(lines[i])) continue;
      const cells = lines[i].split('|').map((s) => s.trim());
      let state = null, stateCell = '';
      for (let c = 2; c < cells.length; c++) {
        const st = normState(cells[c]);
        if (st) { state = st; stateCell = cells[c]; break; }
      }
      if (!state) continue; // 无状态标注的行不是权威行，不猜
      rows.push({ id: cells[1], line: i + 1, state, stateCell });
    }
    const code = rows.length ? rows[0].id.split('-')[1] : f.replace(/^FP-/, '').replace(/\.md$/, '');
    const tally = { up: 0, alt: 0, todo: 0, dead: 0 };
    for (const r of rows) tally[r.state]++;
    pages.push({ file: f, name, code, rows, tally, count: rows.length });
  }
  return pages;
}

/* ------------------------------------------------- 解析 2：欠账总表（旁证，用于交叉校验） */

function parseDebt() {
  if (!isFile(F_DEBT)) return null;
  const md = readUtf8(F_DEBT);
  const out = { waves: {}, total: null, byPage: {}, generated: (/(\d{4}-\d{2}-\d{2})/.exec(md) || [])[1] || null };
  for (const l of md.split(/\r?\n/)) {
    let m = /^\|\s*\*\*(W\d)\*\*\s*\|([^|]*)\|\s*\*\*(\d+)\*\*/.exec(l);
    if (m) { out.waves[m[1]] = { count: parseInt(m[3], 10), desc: plain(m[2]) }; continue; }
    m = /^\|\s*—\s*\|\s*\*\*合计\*\*\s*\|\s*\*\*(\d+)\*\*/.exec(l);
    if (m) { out.total = parseInt(m[1], 10); continue; }
    m = /^\|\s*([A-Z]{2,6})\s+(\S+)\s*\|\s*(\d+)\s*\|/.exec(l);
    if (m) out.byPage[m[1]] = { name: m[2], count: parseInt(m[3], 10) };
  }
  return out;
}

/* ------------------------------------------------- 解析 3：任务清单 T1–T10 / §7 / §7.1 */

function parseTasks() {
  if (!isFile(F_TASKS)) return null;
  const tasks = [], criteria = [], openItems = [];
  let section = '';
  for (const l of readUtf8(F_TASKS).split(/\r?\n/)) {
    if (/^##\s+7\./.test(l)) { section = 'criteria'; continue; }
    if (/^###\s+7\.1/.test(l)) { section = 'open'; continue; }
    if (/^##\s+/.test(l) && !/^##\s+7\./.test(l)) section = '';
    const tm = /^###\s+(T\d+)【([^】]+)】\s*(.*)$/.exec(l);
    if (tm) {
      const rest = tm[3], done = /✅\s*已完成/.test(rest);
      tasks.push({
        id: tm[1], priority: tm[2].trim(), done,
        title: plain(rest.replace(/\s*—\s*✅\s*已完成.*$/, '').replace(/←.*$/, '')),
      });
      continue;
    }
    if (section === 'criteria') {
      const cm = /^-\s*\[( |x|X)\]\s*(.+)$/.exec(l);
      if (cm) criteria.push({ done: cm[1].toLowerCase() === 'x', text: plain(cm[2]) });
      continue;
    }
    if (section === 'open') {
      const om = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(l);
      if (om) openItems.push({ no: om[1], item: plain(om[2]), basis: plain(om[3]), impact: plain(om[4]), action: plain(om[5]) });
    }
  }
  tasks.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
  return { tasks, criteria, openItems };
}

/* ------------------------------------------------- 解析 4：ADR 台账 */

function parseAdrs() {
  if (!fs.existsSync(DIR_ADR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DIR_ADR).filter((x) => /^ADR-\d+.*\.md$/.test(x)).sort()) {
    const md = readUtf8(path.join(DIR_ADR, f));
    const first = (md.split(/\r?\n/).find((l) => /^#\s/.test(l)) || '').replace(/^#\s*/, '');
    const st = /^\|\s*状态\s*\|\s*(.+?)\s*\|\s*$/m.exec(md);
    out.push({ num: (/^ADR-(\d+)/.exec(f) || [, '?'])[1], file: f, title: plain(first), status: st ? plain(st[1]) : '(未标注状态)' });
  }
  return out.sort((a, b) => parseInt(a.num, 10) - parseInt(b.num, 10));
}

/* ------------------------------------------------- 校验 1：基线漂移（复用既有脚本） */

function driftCheck() {
  if (!OPT.drift) return { status: 'skipped', detail: '本次以 --no-drift 生成，未执行漂移校验' };
  if (!isFile(F_DRIFT)) return { status: 'unknown', detail: '未找到 scripts/gen-debt-table.ps1' };
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & \'' + F_DRIFT.replace(/'/g, "''") + '\' -Check';
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (r.error || r.status === null) {
    return { status: 'unknown', detail: '无法执行 PowerShell 校验：' + (r.error ? r.error.message : '超时或未返回') };
  }
  const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  if (r.status !== 0) return { status: 'fail', detail: out || ('校验未通过（退出码 ' + r.status + '）') };
  // 退出码 0 也可能带「汇总漂移」告警（该告警不改变退出码）——必须一并暴露
  if (/汇总漂移/.test(out)) return { status: 'warn', detail: out };
  return { status: 'ok', detail: out || 'CHECK OK' };
}

/* ------------------------------------------------- 校验 2：CI 是否为真绿 */

function analyzeCi() {
  if (!isFile(F_CI)) return { exists: false, jobs: [], findings: [] };
  const txt = readUtf8(F_CI);
  const jobs = [], findings = [];
  const jm = /^jobs:\s*$([\s\S]*)$/m.exec(txt);
  if (jm) {
    for (const l of jm[1].split(/\r?\n/)) {
      const m = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/.exec(l);
      if (m) jobs.push(m[1]);
    }
  }
  const add = (sev, title, evidence, fix) => findings.push({ sev, title, evidence, fix });

  // ① Gradle 构建根是否成立（不只查 wrapper 文件在不在）
  const gm = /cd\s+([\w./-]+)\s*\n\s*\.\/gradlew/.exec(txt);
  if (gm) {
    const dir = gm[1].replace(/\/+$/, '');
    const hasWrapper = isFile(path.join(ROOT, dir, 'gradlew'));
    const rootBuild = ['build.gradle.kts', 'build.gradle'].map((f) => path.join(ROOT, dir, f)).filter(isFile)[0];
    const declaresVersions = rootBuild ? /version\s*["']/.test(readUtf8(rootBuild)) : false;
    if (!hasWrapper || !declaresVersions) {
      add('high', 'Gradle 构建根不成立：ci.yml 在 `' + dir + '/` 下执行 ./gradlew',
        'gradlew 存在=' + hasWrapper + '；该目录根构建脚本声明插件版本=' + declaresVersions
        + '。kmp-shared 由 apps/android-app/settings.gradle.kts 以 :shared 映射引入，插件版本在 apps/android-app/build.gradle.kts',
        '改为在声明了插件版本的根工程下构建（cd apps/android-app && ./gradlew :shared:...）');
    }
  }

  // ② seed 平价测试是否仍会静默跳过却判成功
  const seedTest = path.join(ROOT, 'bff', 'store-node', 'seed', 'run-tests.js');
  if (isFile(seedTest)) {
    const st = readUtf8(seedTest);
    if (/基座库不存在/.test(st) && /process\.exit\(0\)/.test(st)) {
      add('high', 'seed 平价测试在基座库缺失时静默跳过却判成功（假绿）',
        'bff/store-node/seed/run-tests.js：基座库缺失时打印 SKIP 后 process.exit(0)',
        '依赖 testutil.copyBaseDb() 的「按 migrations 全量重建」回退，真实执行差分测试');
    }
  }

  // ③ lint 与覆盖率
  if (!/npm run lint|eslint|ktlint/i.test(txt)) {
    add('med', 'CI 无 lint 门禁', '.github/workflows/ci.yml 各 job 未执行任何 lint',
      '前端执行 npm run lint（ESLint 已是 admin-web 的 devDependency，零新增依赖）');
  } else if (!/lint-zero-dep/.test(txt)) {
    add('med', 'CI 无后端（bff/scripts/ci）静态检查',
      'lint 只覆盖前端；bff/routes/*.js、bff/server.js 从未被解析，语法错误可直接合入',
      '增加 `node scripts/lint-zero-dep.js`（零依赖：全量 node --check + 卫生规则）');
  }
  if (!/--coverage|nyc|c8/i.test(txt)) {
    add('low', 'CI 无覆盖率门禁',
      '.github/workflows/ci.yml 无 coverage 工具',
      'bff 坚持运行时零第三方依赖，引入 c8/nyc 需先决策（见 docs/运行保障层.md §5.2）；当前诚实标注为「未覆盖」');
  }

  // ④ 红线守卫本机可跑性
  if (/bash\s+ci\/redline_guard\.sh/.test(txt) && !isFile(F_REDLINE_PS1)) {
    add('med', '红线守卫仅有 bash 版，本机（Windows 无 bash）跑不了',
      'ci/redline_guard.sh 仅被 CI 调用，本机缺少等价脚本',
      '新增 ci/redline_guard.ps1，保证本机可一键校验红线');
  }

  // ⑤ 服务就绪等待是否可靠
  if (/node server\.js\s*&/.test(txt) && /\n\s*sleep\s+1\s*\n/.test(txt) && !/api\/health/.test(txt)) {
    add('med', '契约测试用固定 sleep 等 BFF 就绪',
      'ci.yml 中 `node server.js &` 后 `sleep 1`，慢 runner 上会失败或空跑',
      '改为轮询 GET /api/health 直到就绪（并设超时失败）');
  }

  // ⑥ 基线漂移是否纳入 CI
  if (!/gen-debt-table/.test(txt)) {
    add('high', 'CI 完全不校验基线 / 欠账总表漂移',
      '.github/workflows/ci.yml 无 gen-debt-table 或等价漂移校验步骤',
      '新增漂移校验 job：pwsh -File scripts/gen-debt-table.ps1 -Check');
  }

  return { exists: true, jobs, findings };
}

/* ------------------------------------------------- 校验 3：本机门禁（可选真跑） */

function runGates() {
  if (!OPT.gates) {
    return [{ name: '本机门禁', status: 'unknown', detail: '本次未执行（加 --gates 才会真跑）。未验证 ≠ 通过。' }];
  }
  const gate = (name, cmd, cwd) => {
    const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', timeout: 900000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    const tail = out ? out.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') : '';
    return {
      name,
      status: r.status === 0 ? 'ok' : 'fail',
      detail: (r.status === 0 ? '退出码 0' : '退出码 ' + (r.status == null ? 'null(未跑成)' : r.status)) + (tail ? '；' + tail : ''),
    };
  };
  const g = [
    gate('admin-web 类型检查', 'npx tsc --noEmit', path.join(ROOT, 'apps', 'admin-web')),
    gate('admin-web 构建', 'npm run build', path.join(ROOT, 'apps', 'admin-web')),
    gate('BFF 测试', 'npm test', path.join(ROOT, 'bff')),
  ];
  g.push(isFile(F_REDLINE_PS1)
    ? gate('红线守卫（本机）', 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + F_REDLINE_PS1 + '"', ROOT)
    : { name: '红线守卫（本机）', status: 'unknown', detail: 'ci/redline_guard.ps1 不存在，本机无法校验' });
  return g;
}

/* ------------------------------------------------------------------ 渲染 */

const BADGE = {
  up: 'b-up', alt: 'b-alt', todo: 'b-todo', dead: 'b-dead',
  ok: 'b-up', fail: 'b-todo', warn: 'b-warn', unknown: 'b-gray', skipped: 'b-gray',
};

function bar(pct, color) {
  const w = Math.max(0, Math.min(100, pct));
  return '<div class="bar"><i style="width:' + w.toFixed(1) + '%;background:' + color + '"></i></div>';
}
function section(title, sub, body) {
  return '<section class="card"><h2>' + esc(title)
    + (sub ? ' <span class="sub">' + esc(sub) + '</span>' : '') + '</h2>' + body + '</section>';
}
function table(head, rows) {
  return '<table><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('')
    + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}
const td = (v) => '<td>' + v + '</td>';

function render(d) {
  const S = [];
  const pctUp = d.total ? (d.up / d.total) * 100 : 0;

  /* 顶部告警：只讲真话 */
  const alerts = [];
  if (d.drift.status === 'fail') alerts.push(['red', '基线漂移：欠账总表或规范附录 A 与基线行不一致', d.drift.detail]);
  else if (d.drift.status === 'warn') alerts.push(['amber', '基线汇总漂移：某份基线的「汇总」数与行标注不一致', d.drift.detail]);
  else if (d.drift.status === 'unknown') alerts.push(['amber', '漂移校验未验证', d.drift.detail]);
  if (d.mismatch.length) alerts.push(['red', '基线解析与欠账总表数字不一致（两处数字对不上即缺陷）', d.mismatch.join('；')]);
  if (d.gates.some((g) => g.status === 'unknown')) alerts.push(['amber', '构建门禁未验证', '本次未真跑门禁；未验证 ≠ 通过。加 --gates 可现场真跑。']);
  if (d.openItems.length) alerts.push(['amber', '存在流程签收敞口 ' + d.openItems.length + ' 项', '代码完成 ≠ 可验收，详见下方「流程签收敞口」']);

  S.push('<div class="alerts">' + (alerts.length
    ? alerts.map((a) => '<div class="alert ' + a[0] + '"><b>' + esc(a[1]) + '</b><div class="dim mono">' + esc(a[2]) + '</div></div>').join('')
    : '<div class="alert green"><b>无告警</b><div class="dim">漂移校验通过、数字一致</div></div>') + '</div>');

  /* 总览 */
  S.push(section('总览', '数据来源：docs/迁移基线的行标注（唯一权威）',
    '<div class="grid4">'
    + '<div class="kpi"><div class="n">' + d.total + '</div><div class="l">功能点总数</div></div>'
    + '<div class="kpi"><div class="n up">' + d.up + '</div><div class="l">⬆️ 已移植</div></div>'
    + '<div class="kpi"><div class="n todo">' + d.todo + '</div><div class="l">⬜ 待补（欠账）</div></div>'
    + '<div class="kpi"><div class="n">' + pctUp.toFixed(1) + '%</div><div class="l">移植完成率</div></div>'
    + '</div>'
    + bar(pctUp, '#16a34a')
    + '<div class="note">另有 ' + d.alt + ' 项等价替代、' + d.dead + ' 项废弃；欠账卡（可执行单元）'
    + (d.debt && d.debt.total != null ? d.debt.total : '?') + ' 张。</div>'));

  /* 按页 */
  S.push(section('按页进度', d.pages.length + ' 份基线',
    table(['页面', '基线文件', '功能点', '⬆️ 已移植', '⬜ 待补', '进度'], d.pages.map((p) => {
      const pct = p.count ? (p.tally.up / p.count) * 100 : 0;
      return '<tr>' + td('<b>' + esc(p.name) + '</b> <span class="dim mono">' + esc(p.code) + '</span>')
        + td('<span class="mono dim">' + esc(p.file) + '</span>')
        + td(String(p.count)) + td('<span class="up">' + p.tally.up + '</span>')
        + td(p.tally.todo ? '<span class="todo">' + p.tally.todo + '</span>' : '0')
        + td(bar(pct, pct >= 100 ? '#16a34a' : '#f59e0b') + '<span class="dim">' + pct.toFixed(0) + '%</span>') + '</tr>';
    }))));

  /* 欠账波次 */
  if (d.debt) {
    const max = Math.max.apply(null, Object.keys(d.debt.waves).map((k) => d.debt.waves[k].count).concat([1]));
    S.push(section('欠账波次分布', '来源：docs/迁移基线/欠账总表.md（脚本生成，勿手改）',
      table(['波次', '口径', '张数', '占比'], Object.keys(d.debt.waves).sort().map((k) => {
        const w = d.debt.waves[k], pct = d.debt.total ? (w.count / d.debt.total) * 100 : 0;
        return '<tr>' + td('<b>' + esc(k) + '</b>') + td(esc(w.desc)) + td(String(w.count))
          + td(bar((w.count / max) * 100, '#3b82f6') + '<span class="dim">' + pct.toFixed(1) + '%</span>') + '</tr>';
      }))));
  }

  /* 任务 */
  if (d.tasks) {
    S.push(section('任务 T1–T10', '来源：docs/下一步任务清单_2026-09-28.md',
      table(['任务', '优先级', '内容', '状态'], d.tasks.tasks.map((t) => '<tr>'
        + td('<b>' + esc(t.id) + '</b>') + td('<span class="dim">' + esc(t.priority) + '</span>')
        + td(esc(t.title))
        + td(t.done ? '<span class="badge b-up">✅ 已完成</span>' : '<span class="badge b-gray">未完成</span>') + '</tr>'))));
  }

  /* 完成判据 */
  if (d.tasks && d.tasks.criteria.length) {
    const done = d.tasks.criteria.filter((c) => c.done).length;
    S.push(section('完成判据（§7）', done + ' / ' + d.tasks.criteria.length + ' 项达成'
      + (done < d.tasks.criteria.length ? ' — 未全部达成前不得对外宣称「进货入库页已完成」' : ''),
      '<ul class="ck">' + d.tasks.criteria.map((c) => '<li>' + (c.done ? '<span class="up">[x]</span> ' : '<span class="todo">[ ]</span> ')
        + esc(c.text) + '</li>').join('') + '</ul>'));
  }

  /* 流程签收敞口 */
  if (d.openItems.length) {
    S.push(section('流程签收敞口（§7.1）', '代码完成 ≠ 可验收；以下为流程签收缺口',
      table(['#', '未满足项', '依据', '影响', '处置'], d.openItems.map((o) => '<tr>'
        + td(esc(o.no)) + td('<b>' + esc(o.item) + '</b>') + td('<span class="dim">' + esc(o.basis) + '</span>')
        + td('<span class="todo">' + esc(o.impact) + '</span>') + td('<span class="dim">' + esc(o.action) + '</span>') + '</tr>'))));
  }

  /* ADR */
  S.push(section('决策（ADR）台账', '来源：docs/decisions/',
    d.adrs.length
      ? table(['编号', '标题', '状态', '文件'], d.adrs.map((a) => '<tr>'
        + td('<b>ADR-' + esc(a.num) + '</b>') + td(esc(a.title)) + td(esc(a.status))
        + td('<span class="mono dim">' + esc(a.file) + '</span>') + '</tr>'))
      : '<div class="note">未找到 ADR 文件</div>'));

  /* 门禁与 CI */
  const gatesHtml = table(['门禁', '结果', '说明'], d.gates.map((g) => '<tr>'
    + td(esc(g.name))
    + td('<span class="badge ' + (BADGE[g.status] || 'b-gray') + '">' + esc(g.status) + '</span>')
    + td('<span class="dim mono">' + esc(g.detail) + '</span>') + '</tr>'));
  const driftHtml = '<div class="note"><b>基线漂移校验</b> <span class="badge ' + (BADGE[d.drift.status] || 'b-gray') + '">'
    + esc(d.drift.status) + '</span><pre class="mono">' + esc(d.drift.detail) + '</pre></div>';
  const ciHtml = d.ci.exists
    ? '<div class="note"><b>CI job（' + d.ci.jobs.length + '）</b> <span class="mono dim">' + esc(d.ci.jobs.join(' · ')) + '</span></div>'
    + (d.ci.findings.length
      ? table(['级别', '已知假绿点', '证据', '修法'], d.ci.findings.map((f) => '<tr>'
        + td('<span class="badge ' + ({ high: 'b-todo', med: 'b-warn', low: 'b-gray' }[f.sev] || 'b-gray') + '">' + esc(f.sev) + '</span>')
        + td('<b>' + esc(f.title) + '</b>') + td('<span class="dim">' + esc(f.evidence) + '</span>')
        + td('<span class="dim">' + esc(f.fix) + '</span>') + '</tr>'))
      : '<div class="note">未检出已知假绿点</div>')
    : '<div class="note">未找到 .github/workflows/ci.yml</div>';
  S.push(section('门禁与 CI 真实状态', 'CI 状态为本地静态分析（不联网）；离线环境不臆测远端结果', driftHtml + gatesHtml + ciHtml));

  /* 数据源 */
  S.push(section('数据源与再生成', '',
    table(['文件', '最后修改'], d.sources.map((s) => '<tr>'
      + td('<span class="mono">' + esc(s[0]) + '</span>') + td('<span class="dim">' + esc(s[1]) + '</span>') + '</tr>'))
    + '<div class="note">重新生成：<span class="mono">node scripts/gen-progress-board.js</span>'
    + '（加 <span class="mono">--gates</span> 会真跑 tsc/build/npm test；加 <span class="mono">--no-drift</span> 跳过漂移校验）'
    + '<br>本看板为派生数据，<b>不得手工编辑</b>；数字以基线行标注为准。</div>'));

  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>项目进度看板</title><style>'
    + ':root{--fg:#0f172a;--dim:#64748b;--line:#e2e8f0;--bg:#f8fafc}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);'
    + 'font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}'
    + 'header{background:#0f172a;color:#fff;padding:20px 28px}'
    + 'header h1{margin:0;font-size:20px}header .meta{color:#94a3b8;font-size:12px;margin-top:6px}'
    + 'main{max-width:1180px;margin:0 auto;padding:20px 28px 60px}'
    + '.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:18px}'
    + '.card h2{margin:0 0 14px;font-size:15px;border-left:3px solid #3b82f6;padding-left:9px}'
    + '.card h2 .sub{font-weight:400;color:var(--dim);font-size:12px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}'
    + 'th{text-align:left;color:var(--dim);font-weight:600;border-bottom:2px solid var(--line);padding:7px 8px;white-space:nowrap}'
    + 'td{border-bottom:1px solid #f1f5f9;padding:7px 8px;vertical-align:top}'
    + 'tr:hover td{background:#fafcff}'
    + '.bar{height:7px;background:#eef2f7;border-radius:4px;overflow:hidden;margin:5px 0}'
    + '.bar i{display:block;height:100%}'
    + '.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:10px}'
    + '.kpi{background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px}'
    + '.kpi .n{font-size:26px;font-weight:700}.kpi .l{color:var(--dim);font-size:12px}'
    + '.up{color:#16a34a}.todo{color:#dc2626}.dim{color:var(--dim)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}'
    + '.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid}'
    + '.b-up{color:#15803d;border-color:#86efac;background:#f0fdf4}'
    + '.b-todo{color:#b91c1c;border-color:#fca5a5;background:#fef2f2}'
    + '.b-alt{color:#0e7490;border-color:#67e8f9;background:#ecfeff}'
    + '.b-dead,.b-gray{color:#475569;border-color:#cbd5e1;background:#f8fafc}'
    + '.b-warn{color:#b45309;border-color:#fcd34d;background:#fffbeb}'
    + '.alert{border-radius:8px;padding:10px 14px;margin-bottom:9px;border:1px solid;font-size:13px}'
    + '.alert.red{background:#fef2f2;border-color:#fca5a5}.alert.amber{background:#fffbeb;border-color:#fcd34d}'
    + '.alert.green{background:#f0fdf4;border-color:#86efac}'
    + '.alerts{margin-bottom:18px}'
    + '.note{background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:12.5px;margin-top:10px}'
    + 'pre.mono{white-space:pre-wrap;margin:6px 0 0;color:var(--dim)}'
    + 'ul.ck{list-style:none;padding-left:0;margin:0}ul.ck li{padding:3px 0;border-bottom:1px solid #f1f5f9}'
    + '</style></head><body>'
    + '<header><h1>熊猫五福餐厅经营系统 · 项目进度看板</h1>'
    + '<div class="meta">生成时间 ' + esc(d.now) + ' · 提交 ' + esc(d.rev)
    + ' · 本页为派生数据（只读），数字以 docs/迁移基线/*.md 行标注为准</div></header>'
    + '<main>' + S.join('') + '</main></body></html>\n';
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const pages = parseBaselines();
  const debt = parseDebt();
  const taskDoc = parseTasks();
  const adrs = parseAdrs();
  const drift = driftCheck();
  const gates = runGates();
  const ci = analyzeCi();

  const tally = { up: 0, alt: 0, todo: 0, dead: 0 };
  for (const p of pages) for (const k of Object.keys(tally)) tally[k] += p.tally[k];
  const total = pages.reduce((s, p) => s + p.count, 0);

  // 交叉校验：基线行标注 vs 欠账总表（两处数字对不上即缺陷，必须红条暴露）
  const mismatch = [];
  if (debt) {
    if (debt.total != null && debt.total !== tally.todo) {
      mismatch.push('欠账总表合计 ' + debt.total + ' 张 ≠ 基线行标注 ⬜ ' + tally.todo + ' 项');
    }
    for (const p of pages) {
      const d = debt.byPage[p.code];
      if (d && d.count !== p.tally.todo) mismatch.push(p.code + '：总表 ' + d.count + ' ≠ 基线 ⬜ ' + p.tally.todo);
    }
  }

  const sources = [
    ['docs/迁移基线/FP-*.md（' + pages.length + ' 份）', mtime(path.join(DIR_BASE, pages.length ? pages[0].file : 'FP-进货入库.md'))],
    ['docs/迁移基线/欠账总表.md', mtime(F_DEBT)],
    ['docs/下一步任务清单_2026-09-28.md', mtime(F_TASKS)],
    ['docs/decisions/ ADR 文件（' + adrs.length + ' 份）', adrs.length ? mtime(path.join(DIR_ADR, adrs[adrs.length - 1].file)) : '—'],
    ['.github/workflows/ci.yml', mtime(F_CI)],
    ['scripts/gen-debt-table.ps1（漂移判据）', mtime(F_DRIFT)],
  ];

  const html = render({
    now: stamp(new Date()), rev: gitRev(),
    pages, total, up: tally.up, alt: tally.alt, todo: tally.todo, dead: tally.dead,
    debt, tasks: taskDoc, openItems: taskDoc ? taskDoc.openItems : [],
    adrs, drift, gates, ci, mismatch, sources,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf8');

  console.log('已生成：' + path.relative(ROOT, OUT_HTML));
  console.log('基线 ' + total + ' 项 → ⬆️ ' + tally.up + ' / ⬜ ' + tally.todo
    + '（等价替代 ' + tally.alt + ' / 废弃 ' + tally.dead + '）');
  console.log('漂移校验：' + drift.status + '；CI 已知假绿点：' + ci.findings.length
    + '；流程签收敞口：' + (taskDoc ? taskDoc.openItems.length : 0)
    + '；数字一致性：' + (mismatch.length ? '不一致(' + mismatch.length + ')' : 'OK'));
  if (mismatch.length) for (const m of mismatch) console.log('  ! ' + m);
  if (drift.status === 'fail' || drift.status === 'warn') console.log('  ! ' + drift.detail);
}

main();
