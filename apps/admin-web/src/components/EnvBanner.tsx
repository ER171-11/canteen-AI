import { Alert } from 'antd'

/**
 * 演练环境横幅。
 *
 * 触发条件：后端 `/api/health` 返回 `env === 'sandbox'`（由启动脚本设置 CANTEEN_ENV=sandbox）。
 * 作用：让使用者一眼看出「当前写入的是演练库，不是真实数据」，避免把测试结果当真实经营数据看。
 * 真实环境（env 缺省或 real）不渲染，界面与以往一致。
 */
export default function EnvBanner({ env }: { env?: string }) {
  if (env !== 'sandbox') return null
  return (
    <Alert
      banner
      type="warning"
      showIcon
      style={{ textAlign: 'center' }}
      message={
        '演练环境 · 数据非真实：写入演练库（真实主库不受影响）；如需重置请执行 node scripts/sandbox-db.js --reset'
      }
    />
  )
}
