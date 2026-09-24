import { Card, Empty, Typography } from 'antd'

/** 未实现模块统一占位页：不留 404 空白 */
export default function PlaceholderPage({ title }: { title: string }) {
  return (
    <Card>
      <Empty
        description={
          <>
            <Typography.Title level={4} style={{ marginBottom: 8 }}>
              {title}
            </Typography.Title>
            <Typography.Text type="secondary">
              建设中，敬请期待。当前 Sprint 0-2 阶段仅开放「经营看板」与「审批中心（只读）」。
            </Typography.Text>
          </>
        }
      />
    </Card>
  )
}
