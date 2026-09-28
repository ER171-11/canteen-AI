import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Form, Input, Space, Typography, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { login as apiLogin } from '../api'
import { getDeviceFp } from '../utils/device'
import { useAuthStore } from '../store/auth'
import { firstAccessiblePath } from '../rbac/roles'
import { COLORS } from '../theme'

interface LoginForm {
  account: string
  password: string
}

/** 一键登录：岗位 → 真实门店账号（局域网联调，密码统一默认） */
const QUICK_LOGIN_ACCOUNTS: { label: string; account: string }[] = [
  { label: '老板', account: 'boss' },
  { label: '店长', account: 'manager' },
  { label: '收银', account: 'cashier' },
  { label: '厨房', account: 'kitchen' },
  { label: '财务', account: 'finance' },
  { label: '只读', account: 'newbie' },
]
const QUICK_LOGIN_PASSWORD = 'wufu123'

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [loading, setLoading] = useState(false)

  const doLogin = async (account: string, password: string) => {
    setLoading(true)
    const deviceFp = getDeviceFp()
    try {
      const resp = await apiLogin({
        account,
        password,
        device_fp: deviceFp,
      })
      if (!resp.ok || !resp.token) {
        message.error(resp.error || '登录失败')
        return
      }
      login({
        token: resp.token,
        role: resp.role,
        account,
        expiresAt: resp.expires_at,
        storeId: resp.store_id ?? null,
        storeName: resp.store_name ?? null,
        permissions: resp.permissions ?? [],
        canWrite: !!resp.can_write,
      })
      message.success(`登录成功 · ${resp.store_name || resp.role}`)
      navigate(firstAccessiblePath(resp.role), { replace: true })
    } catch (err) {
      const status = (err as { response?: { status?: number; data?: { error?: string } } })?.response
      message.error(status?.data?.error || `登录失败（HTTP ${status?.status || '?'}）`)
    } finally {
      setLoading(false)
    }
  }

  const onFinish = (values: LoginForm) => doLogin(values.account, values.password)

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
          <div className="ai-gradient-text" style={{ fontSize: 26, fontWeight: 700 }}>
            熊猫五福餐厅
          </div>
          <Typography.Text type="secondary">管理后台 · 门店岗位账号</Typography.Text>
        </div>
        <Form<LoginForm>
          onFinish={onFinish}
          size="large"
        >
          <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="岗位账号" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading} style={{ background: COLORS.primary }}>
              登 录
            </Button>
          </Form.Item>
        </Form>
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            一键登录（真实岗位账号 · 局域网联调，密码 {QUICK_LOGIN_PASSWORD}）
          </Typography.Text>
          <Space wrap style={{ marginTop: 8 }}>
            {QUICK_LOGIN_ACCOUNTS.map((q) => (
              <Button
                key={q.account}
                size="small"
                disabled={loading}
                onClick={() => doLogin(q.account, QUICK_LOGIN_PASSWORD)}
              >
                {q.label}
              </Button>
            ))}
          </Space>
        </div>
      </Card>
    </div>
  )
}
