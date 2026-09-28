/**
 * 文件下载（Blob + a[download]），移植自旧版 downloadBlob(:5285) / download(:5289)。
 * 结算单是只读输出层：这里只产出文件，不发任何写请求。
 */

export function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export function download(name: string, content: string, type?: string): void {
  downloadBlob(name, new Blob([content], { type: type || 'application/json' }))
}
