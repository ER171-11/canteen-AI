import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Form, Input, Select, Typography, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { login as apiLogin } from '../api'
import type { Role } from '../api/types'
import { getDeviceFp } from '../utils/device'
import { useAuthStore } from '../store/auth'
import { firstAccessiblePath } from '../rbac/roles'
import { COLORS } from '../theme'

const ROLE_OPTIONS: Role[] = ['老板', '店长', '财务', '厨房', '只读']

interface LoginForm {
  account: string
  password: string
  role: Role
}

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [loading, setLoading] = useState(false)

  const onFinish = async (values: LoginForm) => {
    setLoading(true)
    const deviceFp = getDeviceFp()
    try {
      const resp = await apiLogin({
        account: values.account,
        password: values.password,
        device_fp: deviceFp,
      })
      login({
        token: resp.token,
        role: resp.role,
        account: values.account,
        expiresAt: resp.expires_at,
      })
      message.success('登录成功')
      navigate(firstAccessiblePath(resp.role), { replace: true })
    } catch (err) {
      /*
       * Sprint 0：BFF 的 /api/admin/login 尚未上线（当前 BFF 仅代理 Kimi 视觉接口，
       * 会返回 404），且本阶段任意密码均可通过。为不阻塞前端联调，
       * 接口不可用（网络错误 / 404）时以本地模拟 token 放行，角色取表单选择值；
       * 接口返回 401/400 等真实鉴权拒绝时仍按失败处理。
       */
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status && status !== 404) {
        message.error(`登录失败（HTTP ${status}），请检查账号`)
      } else {
        login({
          token: 'dev-mock-' + deviceFp,
          role: values.role,
          account: values.account,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        })
        message.warning('BFF 登录接口未就绪，已使用本地模拟登录（Sprint 0）')
        navigate(firstAccessiblePath(values.role), { replace: true })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            className="ai-gradient-text"
            style={{ fontSize: 26, fontWeight: 700 }}
          >
            熊猫五福餐厅
          </div>
          <Typography.Text type="secondary">管理后台 · Admin Web</Typography.Text>
        </div>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Sprint 0：任意密码可登录；BFF 未就绪时自动本地模拟登录。"
        />
        <Form<LoginForm>
          onFinish={onFinish}
          initialValues={{ role: '老板' }}
          size="large"
        >
          <Form.Item
            name="account"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="账号" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码（本阶段任意）' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码（Sprint 0 任意）" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            tooltip="正式环境由 BFF 下发；仅本地模拟登录时生效"
          >
            <Select
              options={ROLE_OPTIONS.map((r) => ({ value: r, label: r }))}
            />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loading}
              style={{ background: COLORS.primary }}
            >
              登 录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
