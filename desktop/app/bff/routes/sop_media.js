'use strict'
/*
 * SOP 视频教材（C 块后台）：只读列表 + 绑定上传。
 *
 * 视频本身不进本服务（与「图片不落盘」同一红线）：
 *  - 后台把已经托管好的视频 URL（对象存储 / 点播）与菜品 sku 绑定；
 *  - 本路由只存「sku_id → video_url」引用到 data.ext.sop_videos，绝不接收视频字节或 base64。
 *  - 任何带图片/视频 base64 的载荷直接 400 image_payload_rejected（复用 qc_media 的守卫）。
 */
const { readBody } = require('../lib/algorithms/ops')
const { hasImagePayload } = require('./qc_media')

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function listAll(ctx) {
  if (ctx.store && ctx.store.data && ctx.store.data.ext) return ctx.store.data.ext.sop_videos || []
  return (ctx.data && ctx.data.ext && ctx.data.ext.sop_videos) || []
}

async function handle(req, res, ctx, pathname) {
  if (pathname === '/api/kitchen/sop-videos') {
    if (req.method === 'GET') {
      const sku = ctx.query && ctx.query.sku_id
      const all = listAll(ctx)
      const items = sku ? all.filter((v) => v.sku_id === sku) : all
      json(res, 200, { ok: true, items, mock: false })
      return true
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (hasImagePayload(body)) {
        json(res, 400, { ok: false, error: 'image_payload_rejected' })
        return true
      }
      const sku_id = body && body.sku_id
      const video_url = body && body.video_url
      if (!sku_id || !video_url) {
        json(res, 400, { ok: false, error: 'sku_id & video_url required' })
        return true
      }
      const row = {
        id: 'sv_' + Date.now(),
        sku_id,
        title: (body.title || '').toString().slice(0, 80),
        video_url: video_url.toString().slice(0, 2000),
        ts: new Date().toISOString(),
      }
      const all = listAll(ctx).slice()
      all.push(row)
      if (ctx.store && ctx.store.data) {
        ctx.store.data.ext = ctx.store.data.ext || {}
        ctx.store.data.ext.sop_videos = all
        if (typeof ctx.store.save === 'function') await ctx.store.save()
      } else {
        ctx.data = ctx.data || {}
        ctx.data.ext = ctx.data.ext || {}
        ctx.data.ext.sop_videos = all
      }
      json(res, 200, { ok: true, item: row })
      return true
    }
  }
  return false
}

module.exports = { handle }
