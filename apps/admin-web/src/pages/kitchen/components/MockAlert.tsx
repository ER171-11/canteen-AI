import { Alert } from 'antd'

/** BFF 未就绪提示：展示内置演示数据 */
export default function MockAlert({ endpoint }: { endpoint: string }) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={`BFF 未就绪（${endpoint} 不可用），当前展示内置演示数据。`}
    />
  )
}
