import { Alert } from 'antd'

/**
 * BFF 未就绪提示。
 * 内置演示数据已淘汰，接口无数据时界面统一回落空态。
 */
export default function MockAlert({ endpoint }: { endpoint: string }) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={`BFF 未就绪（${endpoint} 不可用），暂无数据。`}
    />
  )
}
