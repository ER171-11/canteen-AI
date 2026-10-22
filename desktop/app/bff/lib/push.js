'use strict';
/*
 * lib/push.js — SI 推送分发（P0：本地 feed + token 登记；P1 可插 FCM/APNs）
 *
 * 设计：定义 PushChannel 概念，默认 LocalFeedChannel 把通知写入 data/si_feed.json，
 * 客户端通过 /api/inbox 拉取（后台 WorkManager 轮询）或 /api/inbox/stream 实时收。
 * 拿到 FCM/APNs 凭证后，在此新增云端通道即可，业务层无需改动。
 */
const store = require('./store');

const TOKENS_FILE = 'push_tokens.json';
const FEED_FILE = 'si_feed.json';
const MAX_FEED = 200;

function loadTokens() {
  const t = store.readJSON(TOKENS_FILE, []);
  return Array.isArray(t) ? t : [];
}

/** 登记设备 token（幂等：同 token 覆盖 platform） */
function registerToken(token, platform, account) {
  const v = String(token || '').trim();
  if (!v) return null;
  const list = loadTokens().filter((x) => x && x.token !== v);
  const rec = { token: v, platform: String(platform || 'android'), account: account || null, ts: new Date().toISOString() };
  list.push(rec);
  store.writeJSON(TOKENS_FILE, list.slice(-500));
  return rec;
}

function removeToken(token) {
  const v = String(token || '').trim();
  store.writeJSON(TOKENS_FILE, loadTokens().filter((x) => x && x.token !== v));
}

function loadFeed() {
  const f = store.readJSON(FEED_FILE, []);
  return Array.isArray(f) ? f : [];
}

/**
 * 往 SI 收件箱投递一条通知。
 * @param {object} item {kind,title,body,route,level,meta}
 * @returns {object} 写入后的条目
 */
function dispatch(item) {
  const list = loadFeed();
  const rec = {
    id: 'ntf_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
    ts: new Date().toISOString(),
    kind: String((item && item.kind) || 'info'),
    level: String((item && item.level) || 'info'),
    title: String((item && item.title) || ''),
    body: String((item && item.body) || ''),
    route: (item && item.route) || null,
    read: false,
    meta: (item && item.meta) || null
  };
  list.push(rec);
  store.writeJSON(FEED_FILE, list.slice(-MAX_FEED));
  return rec;
}

function feed(sinceTs) {
  const list = loadFeed();
  if (!sinceTs) return list;
  const t = new Date(sinceTs).getTime();
  if (isNaN(t)) return list;
  return list.filter((x) => new Date(x.ts).getTime() > t || x.read === false);
}

function ack(id) {
  const list = loadFeed();
  let changed = false;
  for (const x of list) {
    if (id ? x.id === id : true) { x.read = true; changed = true; }
  }
  if (changed) store.writeJSON(FEED_FILE, list);
  return changed;
}

function unreadCount() {
  return loadFeed().filter((x) => !x.read).length;
}

/* 云端通道预留：无凭证时返回 false，由本地 feed 兜底 */
function cloudConfigured() {
  return !!(process.env.FCM_SERVER_KEY || process.env.APNS_KEY_ID);
}

module.exports = { registerToken, removeToken, dispatch, feed, ack, unreadCount, cloudConfigured, FEED_FILE };
