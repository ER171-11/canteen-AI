import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Switch,
  Typography,
  Upload,
  message,
} from 'antd'
import type { UploadProps } from 'antd'
import { PictureOutlined, UploadOutlined } from '@ant-design/icons'
import axios from 'axios'
import { presignSafetyPointDemo, upsertSafetyPoint } from '../../api'
import type { SafetyPoint, SafetyPointKind } from '../../api/types'
import { COLORS } from '../../theme'

/** 自定义点位 id：U + 时间戳 + 随机，避免与内置 K/F/C/D 前缀冲突 */
export function genPointId(): string {
  return 'U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

interface Props {
  open: boolean
  kind: SafetyPointKind
  point: SafetyPoint | null
  /** 对象存储是否可用（false 时演示图降级） */
  configured: boolean
  /** 已解析的演示图读图地址（私有 bucket 由父组件换签） */
  demoUrl?: string | null
  onCancel: () => void
  onSaved: () => void
}

export default function PointEditModal({
  open,
  kind,
  point,
  configured,
  demoUrl,
  onCancel,
  onSaved,
}: Props) {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pid, setPid] = useState('')
  const [demoKey, setDemoKey] = useState<string | null>(null)
  const [localUrl, setLocalUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPid(point?.id || genPointId())
    setDemoKey(point?.demo_image_key ?? null)
    setLocalUrl(demoUrl ?? point?.demo_image_url ?? null)
    form.setFieldsValue({
      name: point?.name ?? '',
      zone: point?.zone ?? '',
      every30: point?.every30 === 1,
      sort: point?.sort ?? 0,
      note: point?.note ?? '',
    })
  }, [open, point, demoUrl, form])

  const uploadDemo: UploadProps['customRequest'] = async ({ file, onSuccess, onError }) => {
    const f = file as File
    const ext = (f.name.split('.').pop() || 'jpg').toLowerCase()
    setUploading(true)
    try {
      const pre = await presignSafetyPointDemo({
        kind,
        id: pid,
        ext,
        content_type: f.type || 'image/jpeg',
      })
      if (!pre.configured || !pre.upload_url) {
        message.warning(pre.note || '对象存储未配置，演示图暂不可用')
        onError?.(new Error('objstore not configured'))
        return
      }
      await axios.put(pre.upload_url, f, { headers: pre.headers })
      setDemoKey(pre.key)
      setLocalUrl(pre.photo_url ?? null)
      message.success('演示图已上传，保存后生效')
      onSuccess?.({}, f as unknown as XMLHttpRequest)
    } catch (e) {
      message.error('演示图上传失败，请重试')
      onError?.(e as Error)
    } finally {
      setUploading(false)
    }
  }

  const submit = async () => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      const res = await upsertSafetyPoint({
        id: pid,
        name: v.name,
        zone: v.zone || undefined,
        kind,
        every30: v.every30 ? 1 : 0,
        sort: v.sort ?? 0,
        note: v.note || undefined,
        demo_image_key: demoKey,
        demo_image_url: localUrl,
      })
      if (res.ok) {
        message.success(res.note || '点位变更已入队，待审批中心确认')
        onSaved()
      } else message.error(res.error || '保存失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={point ? '编辑点位' : '新增点位'}
      open={open}
      onCancel={onCancel}
      onOk={submit}
      confirmLoading={busy}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="name"
          label="点位名称"
          rules={[{ required: true, message: '请填写点位名称' }]}
        >
          <Input placeholder={kind === 'inspection' ? '如：外门锁闭' : '如：前厅公共区域'} />
        </Form.Item>
        <Form.Item name="zone" label={kind === 'inspection' ? '所属板块' : '所属区域'}>
          <Input placeholder={kind === 'inspection' ? '后厨 / 前厅 / 仓库' : '后厨 / 前厅 / 洗消'} />
        </Form.Item>
        {kind === 'inspection' && (
          <Form.Item name="every30" label="每 30 分钟记录" valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        <Form.Item name="sort" label="排序权重（越小越靠前）">
          <InputNumber min={0} max={9999} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} placeholder="选填，如操作要点或责任岗位" />
        </Form.Item>
        <Form.Item label="规范演示图">
          <Space direction="vertical" size={8}>
            {localUrl ? (
              <img
                src={localUrl}
                alt="规范演示图"
                style={{
                  width: 180,
                  height: 130,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.gray}33`,
                }}
              />
            ) : (
              <Typography.Text type="secondary">
                <PictureOutlined /> 未上传演示图
              </Typography.Text>
            )}
            <Upload accept="image/*" showUploadList={false} customRequest={uploadDemo}>
              <Button icon={<UploadOutlined />} loading={uploading} disabled={!configured}>
                上传演示图
              </Button>
            </Upload>
            {!configured && (
              <Typography.Text type="warning">对象存储未配置，演示图暂不可用</Typography.Text>
            )}
          </Space>
        </Form.Item>
        <Alert
          type="info"
          showIcon
          message="点位变更进入审批中心，确认通过才写回店内库；演示图直传对象存储，服务器只保存引用。"
        />
      </Form>
    </Modal>
  )
}
