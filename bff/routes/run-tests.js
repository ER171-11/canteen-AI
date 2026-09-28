'use strict';
/*
 * routes/run-tests.js — BFF 路由层回归测试（零依赖，node 直跑）
 *
 * 覆盖 routes/settle.js：
 *   · GET/PUT 往返、默认值回落、白名单清洗（未知字段必须丢弃）
 *   · RBAC：只读角色不得写
 *   · 红线：模板不得污染 snapshot.json（结算单是只读输出层）
 *
 * 运行：node routes/run-tests.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-routes-'));
process.env.BFF_DATA_DIR = dir;

const settle = require('./settle');

function mkctx(role) {
  return {
    auth: role ? { role, account: 'u1' } : null,
    traceId: 't-test',
    sendJSON: (res, code, obj) => {
      res.code = code;
      res.body = obj;
    },
    readBody: async (req) => ({ buf: Buffer.from(String(req.__body || '{}'), 'utf8') }),
  };
}

async function main() {
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (!cond) {
      fail++;
      console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
    } else {
      console.log('ok   ' + name);
    }
  };

  let res = {};
  await settle.handle({ method: 'GET' }, res, mkctx('老板'), '/api/settle/template');
  ok('GET 返回 200', res.code === 200, res);
  ok('GET 首次 source=default', res.body && res.body.source === 'default', res.body);
  ok('默认签字栏三项', res.body && res.body.template.subjects.length === 3, res.body);

  res = {};
  await settle.handle(
    {
      method: 'PUT',
      __body: JSON.stringify({ template: { title: '付款审批单', subjects: '经办人/审核人/审批人/财务' } }),
    },
    res,
    mkctx('老板'),
    '/api/settle/template',
  );
  ok('PUT 返回 200', res.code === 200, res);
  ok('subjects 按分隔符拆成 4 项', res.body && res.body.template.subjects.length === 4, res.body);

  res = {};
  await settle.handle({ method: 'GET' }, res, mkctx('老板'), '/api/settle/template');
  ok('GET 二次 source=file', res.body && res.body.source === 'file', res.body);
  ok('回读 title 一致', res.body && res.body.template.title === '付款审批单', res.body);

  res = {};
  await settle.handle(
    { method: 'PUT', __body: JSON.stringify({ template: { title: 'x' } }) },
    res,
    mkctx('只读'),
    '/api/settle/template',
  );
  ok('只读角色 PUT 被拒 403', res.code === 403, res);

  res = {};
  await settle.handle(
    { method: 'PUT', __body: JSON.stringify({ template: { evil: 'x', subjects: [] } }) },
    res,
    mkctx('老板'),
    '/api/settle/template',
  );
  ok('未知字段被丢弃（白名单）', res.body && res.body.template.evil === undefined, res.body);
  ok('空 subjects 回落默认', res.body && res.body.template.subjects.length === 3, res.body);

  res = {};
  await settle.handle({ method: 'PUT', __body: 'not-json' }, res, mkctx('老板'), '/api/settle/template');
  ok('非法 JSON 返回 400', res.code === 400, res);

  const other = {};
  const took = await settle.handle({ method: 'GET' }, other, mkctx('老板'), '/api/other');
  ok('非本路由不接管', took === false);

  ok('未创建 snapshot.json（不碰业务库）', !fs.existsSync(path.join(dir, 'snapshot.json')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? '== routes 测试失败 ' + fail + ' 项 ==' : '== routes 测试全部通过 ==');
  process.exit(fail ? 1 : 0);
}

main();
