import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  QRCode,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  AndroidOutlined,
  CopyOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { fetchAppRelease } from '../api'
import type { AppRelease } from '../api/types'

const { Title, Paragraph, Text } = Typography

/*
 * App 下载（局域网分发）：
 *   安装包由 BFF 直接下发（GET /api/app/download，免登录），
 *   手机与 PC 处于同一局域网时扫码即可安装。版本/哈希取自 Android 构建产物。
 */
export default function AppReleasePage() {
  const [release, setRelease] = useState<AppRelease | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetchAppRelease()
      .then((data) => {
        setRelease(data)
        setError(null)
      })
      .catch((e) => setError(e?.response?.data?.error || e?.message || '读取安装包信息失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** 手机扫码用的局域网绝对地址（优先 BFF 探测到的内网 IP） */
  const lanUrl = useMemo(() => {
    const port = release?.lan?.port ?? 8787
    const path = release?.downloadPath ?? '/api/app/download'
    const fromBff = release?.lan?.urls?.[0]
    if (fromBff) return fromBff
    if (typeof window === 'undefined') return path
    return `${window.location.protocol}//${window.location.hostname}:${port}${path}`
  }, [release])

  const downloadHref = release?.downloadPath ?? '/api/app/download'
  const available = !!release?.available

  const copy = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => message.success('已复制'))
      .catch(() => message.error('复制失败，请手动复制'))
  }

  return (
    <div style={{ maxWidth: 1080 }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Title level={4} style={{ margin: 0 }}>
          <AndroidOutlined /> App 下载
        </Title>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
      </Space>

      <Paragraph type="secondary" style={{ marginTop: 8 }}>
        老板 SI 手机 App（Android）。安装包由本机 BFF 直接下发，<Text strong>手机连同一 Wi-Fi 扫码即可安装</Text>
        ，无需登录即可下载。
      </Paragraph>

      {error && (
        <Alert
          type="error"
          showIcon
          message="无法读取安装包信息"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}

      {!loading && release && !available && (
        <Alert
          type="warning"
          showIcon
          message="尚未找到构建好的安装包"
          description={
            <span>
              {release.note || '请先构建 APK'}：在 <Text code>apps/android-app</Text> 执行{' '}
              <Text code>./gradlew :app:assembleDebug</Text>，或用环境变量{' '}
              <Text code>APP_APK_PATH</Text> 指定安装包路径后重试。
            </span>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Card
        title="安装包信息"
        loading={loading}
        extra={
          available ? <Tag color="green">v{release?.versionName || '-'}</Tag> : <Tag>未就绪</Tag>
        }
        style={{ marginBottom: 16 }}
      >
        <Descriptions column={{ xs: 1, sm: 2 }} size="small" colon={false}>
          <Descriptions.Item label="版本">
            {release?.versionName || '-'}
            {release?.versionCode != null ? ` (build ${release.versionCode})` : ''}
          </Descriptions.Item>
          <Descriptions.Item label="安装包">
            {release?.file || '-'}
            {release?.sizeText ? ` · ${release.sizeText}` : ''}
          </Descriptions.Item>
          <Descriptions.Item label="包名">{release?.applicationId || '-'}</Descriptions.Item>
          <Descriptions.Item label="适用系统">
            {release?.minSdk != null ? `Android ${release.minSdk}+` : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="构建时间">
            {release?.builtAt ? dayjs(release.builtAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="构建类型">{release?.variant || '-'}</Descriptions.Item>
          <Descriptions.Item label="SHA256" span={2}>
            {release?.sha256 ? (
              <Space>
                <Text code style={{ fontSize: 12 }}>
                  {release.sha256.slice(0, 16)}…{release.sha256.slice(-8)}
                </Text>
                <Button size="small" type="link" onClick={() => copy(release.sha256!)}>
                  复制完整
                </Button>
              </Space>
            ) : (
              '-'
            )}
          </Descriptions.Item>
        </Descriptions>

        <Divider style={{ margin: '12px 0' }} />

        <Space wrap>
          <Button
            type="primary"
            size="large"
            icon={<DownloadOutlined />}
            href={available ? downloadHref : undefined}
            disabled={!available}
          >
            下载 Android 安装包
          </Button>
          {available && release?.sizeText && (
            <Text type="secondary">（{release.sizeText}，下载后点击安装）</Text>
          )}
        </Space>
      </Card>

      <Card title="手机扫码安装" style={{ marginBottom: 16 }}>
        <Space align="start" size={24} wrap>
          <div style={{ textAlign: 'center' }}>
            {available ? (
              <QRCode value={lanUrl} size={196} bordered />
            ) : (
              <div
                style={{
                  width: 196,
                  height: 196,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px dashed #d9d9d9',
                  borderRadius: 8,
                  color: '#999',
                }}
              >
                安装包未就绪
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                用手机相机/浏览器扫码
              </Text>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 280 }}>
            <Paragraph strong style={{ marginBottom: 4 }}>
              1. 手机连接与电脑相同的 Wi-Fi
            </Paragraph>
            <Paragraph style={{ marginBottom: 12 }}>
              2. 扫描左侧二维码，或直接用手机浏览器打开下面地址：
            </Paragraph>
            <Paragraph
              copyable={{ text: lanUrl, icon: <CopyOutlined /> }}
              style={{
                background: '#fafafa',
                border: '1px solid #f0f0f0',
                borderRadius: 8,
                padding: '8px 12px',
                maxWidth: 520,
                marginBottom: 12,
                wordBreak: 'break-all',
              }}
            >
              {lanUrl}
            </Paragraph>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              3. 下载完成后点击安装。若提示「禁止安装未知应用」，请在系统设置里允许浏览器安装应用。
              正式版请通过签名包分发。
            </Paragraph>
          </div>
        </Space>
      </Card>
    </div>
  )
}
