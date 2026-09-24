/** 设备指纹：随机串持久化于 localStorage，登录时随 account 一并上报 */
const KEY = 'panda_device_fp'

export function getDeviceFp(): string {
  let fp = localStorage.getItem(KEY)
  if (!fp) {
    fp =
      'fp_' +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6)
    localStorage.setItem(KEY, fp)
  }
  return fp
}
