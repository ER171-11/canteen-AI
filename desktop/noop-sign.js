#!/usr/bin/env node
// 本地无代码签名构建用的「空签名」脚本。
//
// 重要：electron-builder 会以 require() 方式加载本文件，并取导出的函数作为 Windows 签名器
// （见 app-builder-lib/out/platformPackager.js 的 resolveFunction）。
// 绝不能在文件顶层调用 process.exit()，否则 require 的瞬间会直接杀死主进程，
// 表现为「building target=nsis 之后静默 exit 0、不产出安装包、无任何报错」。
//
// 这里导出一个异步空函数：让 electron-builder 跳过 Windows 代码签名（不会去下载/调用 winCodeSign）。
// 签名器约定签名为 async (configuration, packager) => Promise<void>。
module.exports = async function noopSign(/* configuration, packager */) {
  // 本地环境无代码签名证书，直接跳过签名步骤。
  return;
};
