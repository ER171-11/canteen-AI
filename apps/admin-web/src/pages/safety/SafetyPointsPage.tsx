import { Tabs, Typography } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import PointsPanel from './PointsPanel'
import InspectionBoardPage from './InspectionBoardPage'
import DisinfectPage from './DisinfectPage'
import { COLORS } from '../../theme'

/**
 * 食安点位统筹：合并原「巡检统筹」与「消毒记录」两个入口。
 * 页内 Tabs 切换两个视图，每个视图自上而下为「点位清单」+ 既有业务视图。
 * 业务统计（巡检板块完成率 / 消毒达标率）已由后端改为读取这套可配置点位。
 */
export default function SafetyPointsPage() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${COLORS.green}1a`,
            color: COLORS.green,
            fontSize: 18,
          }}
        >
          <SafetyCertificateOutlined />
        </span>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            食安点位统筹
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            维护巡检点与消毒点主数据，巡检看板与消毒达标率均以此计算；每个点位可配置一张规范演示图。
          </Typography.Text>
        </div>
      </div>

      <Tabs
        defaultActiveKey="inspection"
        destroyInactiveTabPane
        items={[
          {
            key: 'inspection',
            label: '巡检统筹',
            children: (
              <>
                <PointsPanel kind="inspection" title="巡检点位清单" />
                <InspectionBoardPage />
              </>
            ),
          },
          {
            key: 'disinfect',
            label: '消毒记录',
            children: (
              <>
                <PointsPanel kind="disinfect" title="消毒点位清单" />
                <DisinfectPage />
              </>
            ),
          },
        ]}
      />
    </div>
  )
}
