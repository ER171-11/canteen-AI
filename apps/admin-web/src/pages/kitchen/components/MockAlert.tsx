import { Alert, Button } from 'antd'

/**
 * BFF 未就绪提示。
 * 内置演示数据已淘汰，接口无数据时界面统一回落空态。
 *
 * 可选 `detail`：把「为什么不可用」（连接被拒 / 404 无快照 / HTTP 状态码）如实告诉用户，
 * 避免把「后端没起来」误读成「店里没有单据」。
 * 可选 `onRetry`：后端恢复后无需整页刷新即可重新取数。
 */
export default function MockAlert({
  endpoint,
  detail,
  onRetry,
}: {
  endpoint: string
  detail?: string
  onRetry?: () => void
}) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={`BFF 未就绪（${endpoint} 不可用），暂无数据。`}
      description={detail || undefined}
      action={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  )
}
