import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  createOrgUser,
  fetchOrg,
  resetOrgPassword,
  updateOrgPosition,
  updateOrgUser,
} from '../api'
import type { OrgOverview, OrgPosition, OrgUser } from '../api/types'

const MODULE_LABELS: Record<string, string> = {
  inventory: '进销存',
  kitchen: '厨房',
  pos: '堂食',
  booking: '预订',
  foodsafe: '食安',
  staff: '人事',
  finance: '财务',
  vip: '会员',
  takeout: '外卖',
  analysis: '分析',
  supply: '供应链',
  loss: '损耗',
  equipment: '设备',
  review: '口碑',
  actions: '审批',
  org: '组织',
}

export default function OrgPage() {
  const [data, setData] = useState<OrgOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [posOpen, setPosOpen] = useState(false)
  const [editingPos, setEditingPos] = useState<OrgPosition | null>(null)
  const [posForm] = Form.useForm()
  const [userOpen, setUserOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<OrgUser | null>(null)
  const [userForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchOrg()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const modules = data?.modules || Object.keys(MODULE_LABELS)

  const columns: ColumnsType<OrgUser> = [
    { title: '账号', dataIndex: 'account', width: 110 },
    { title: '姓名', dataIndex: 'display_name', width: 100 },
    { title: '岗位', dataIndex: 'position_name', width: 90 },
    { title: '门店', dataIndex: 'store_name', width: 160, ellipsis: true },
    {
      title: '可写',
      dataIndex: 'can_write',
      width: 70,
      render: (v: boolean) => (v ? <Tag color="green">可写</Tag> : <Tag>只读</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: string) =>
        v === 'disabled' || v === '停用' ? <Tag color="red">停用</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: '操作',
      key: 'act',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          <Button
            size="small"
            onClick={() => {
              setEditingUser(r)
              userForm.setFieldsValue({
                account: r.account,
                display_name: r.display_name,
                position_id: r.position_id,
                status: r.status === 'disabled' || r.status === '停用' ? 'disabled' : 'active',
              })
              setUserOpen(true)
            }}
          >
            改岗
          </Button>
          <Button
            size="small"
            onClick={async () => {
              try {
                await resetOrgPassword({ account: r.account, password: 'wufu123' })
                message.success(`${r.account} 密码已重置为 wufu123`)
              } catch (e: unknown) {
                const err = e as { response?: { data?: { error?: string } } }
                message.error(err.response?.data?.error || '重置失败')
              }
            }}
          >
            重置密码
          </Button>
          <Button
            size="small"
            danger={!(r.status === 'disabled' || r.status === '停用')}
            onClick={async () => {
              const next = r.status === 'disabled' || r.status === '停用' ? 'active' : 'disabled'
              try {
                await updateOrgUser({ account: r.account, status: next })
                message.success(next === 'disabled' ? '已停用' : '已启用')
                load()
              } catch (e: unknown) {
                const err = e as { response?: { data?: { error?: string } } }
                message.error(err.response?.data?.error || '失败')
              }
            }}
          >
            {r.status === 'disabled' || r.status === '停用' ? '启用' : '停用'}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title="门店" loading={loading}>
        <Table
          rowKey="id"
          pagination={false}
          dataSource={data?.stores || []}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '品牌', dataIndex: 'brand', width: 120 },
            { title: '城市', dataIndex: 'city', width: 100 },
            { title: '地址', dataIndex: 'address' },
            { title: '状态', dataIndex: 'status', width: 100 },
          ]}
        />
      </Card>

      <Card
        title="岗位权限"
        loading={loading}
        extra={<span style={{ color: '#888', fontSize: 12 }}>点「改权限」按模块勾选读写</span>}
      >
        <Table
          rowKey="id"
          pagination={false}
          dataSource={data?.positions || []}
          columns={[
            { title: '岗位', dataIndex: 'name', width: 100 },
            {
              title: '可写',
              dataIndex: 'write',
              width: 70,
              render: (v: boolean) => (v ? '是' : '否'),
            },
            {
              title: '权限摘要',
              dataIndex: 'permissions',
              render: (p: string[]) =>
                (p || []).slice(0, 6).join(' · ') + ((p?.length || 0) > 6 ? '…' : ''),
            },
            {
              title: '操作',
              width: 100,
              render: (_, r) => (
                <Button
                  size="small"
                  onClick={() => {
                    setEditingPos(r)
                    const perms = r.permissions || []
                    const selected: string[] = []
                    for (const m of modules) {
                      if (perms.includes(`${m}.read`)) selected.push(`${m}.read`)
                      if (perms.includes(`${m}.write`)) selected.push(`${m}.write`)
                    }
                    posForm.setFieldsValue({
                      name: r.name,
                      write: !!r.write,
                      permissions: selected,
                    })
                    setPosOpen(true)
                  }}
                >
                  改权限
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="员工账号"
        loading={loading}
        extra={
          <Button type="link" onClick={load}>
            刷新
          </Button>
        }
      >
        {!data && <Alert type="warning" showIcon message="无法加载组织数据（需登录且 BFF 已启动）" />}
        <Table rowKey="id" columns={columns} dataSource={data?.users || []} pagination={{ pageSize: 10 }} />
      </Card>

      <Card title="创建账号（需老板 org.write）">
        <Form
          layout="inline"
          onFinish={async (v) => {
            setCreating(true)
            try {
              await createOrgUser({
                account: v.account,
                password: v.password || 'wufu123',
                display_name: v.display_name,
                position_id: v.position_id,
                store_id: data?.stores?.[0]?.id,
              })
              message.success('已创建')
              load()
            } catch (e: unknown) {
              const err = e as { response?: { data?: { error?: string } } }
              message.error(err.response?.data?.error || '创建失败')
            } finally {
              setCreating(false)
            }
          }}
        >
          <Form.Item name="account" rules={[{ required: true }]}>
            <Input placeholder="账号" />
          </Form.Item>
          <Form.Item name="display_name">
            <Input placeholder="姓名" />
          </Form.Item>
          <Form.Item name="password">
            <Input.Password placeholder="密码（默认 wufu123）" />
          </Form.Item>
          <Form.Item name="position_id" initialValue="pos_readonly" rules={[{ required: true }]}>
            <Select
              style={{ width: 140 }}
              options={(data?.positions || []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={creating}>
              创建
            </Button>
          </Form.Item>
        </Form>
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message="App 邀请码默认 WUFU2026；组织改岗/停用即时生效（不经确认台），店内主数据写仍走确认台。"
        />
      </Card>

      <Modal
        title={`改岗 · ${editingUser?.account || ''}`}
        open={userOpen}
        onCancel={() => setUserOpen(false)}
        onOk={async () => {
          const v = await userForm.validateFields()
          try {
            await updateOrgUser(v)
            message.success('已更新')
            setUserOpen(false)
            load()
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '失败')
          }
        }}
        destroyOnClose
      >
        <Form form={userForm} layout="vertical">
          <Form.Item name="account" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="姓名">
            <Input />
          </Form.Item>
          <Form.Item name="position_id" label="岗位" rules={[{ required: true }]}>
            <Select options={(data?.positions || []).map((p) => ({ value: p.id, label: p.name }))} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              options={[
                { value: 'active', label: '正常' },
                { value: 'disabled', label: '停用' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`岗位权限 · ${editingPos?.name || ''}`}
        open={posOpen}
        width={640}
        onCancel={() => setPosOpen(false)}
        onOk={async () => {
          const v = await posForm.validateFields()
          try {
            await updateOrgPosition({
              id: editingPos?.id,
              name: v.name,
              write: v.write,
              permissions: v.permissions,
            })
            message.success('岗位权限已保存')
            setPosOpen(false)
            load()
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '失败')
          }
        }}
        destroyOnClose
      >
        <Form form={posForm} layout="vertical">
          <Form.Item name="name" label="岗位名">
            <Input />
          </Form.Item>
          <Form.Item name="write" label="允许写操作" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="permissions" label="模块权限">
            <Checkbox.Group style={{ width: '100%' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {modules.map((m) => (
                  <div key={m}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{MODULE_LABELS[m] || m}</div>
                    <Checkbox value={`${m}.read`}>读</Checkbox>
                    <Checkbox value={`${m}.write`} style={{ marginLeft: 8 }}>
                      写
                    </Checkbox>
                  </div>
                ))}
              </div>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
