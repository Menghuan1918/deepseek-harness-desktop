# S5 桌面壳集成 — GUI 手动验收清单（无头环境无法目视的走查项）

S5 验收中「数据面全旅程」「壳层命令/单测/lint」「capability」「旧概念残留」
已自动化并留证（见 `s5-ssh-e2e-evidence.md` 与下方对应节）。以下条目需要
真人目视 `pnpm tauri dev` GUI（无头环境**未验证**），逐项勾选：

## 准备

- [ ] worktree 内 `pnpm install && pnpm build:plugins`，`pnpm tauri dev`
      （debug 端口 3081 / DSH_HOME `~/.dsh.dev`；注意 1420 端口空闲）。
- [ ] dev 机器可在 web 设置页添加（host=dev 别名即被 ~/.ssh/config 发现）；
      如远端 home 层 pin 了 webserver 端口，机器配置里填自定义启动命令
      （证据文档「dev 机器环境注记」有可抄的一条）。

## A 切换器（navbar）

- [ ] 就绪态 navbar 出现地球图标切换器；安装/错误/预装引导阶段不出现。
- [ ] 下拉含「本地」项 + 机器项（手动机器与 ~/.ssh/config 别名机器都在）。
- [ ] 色点语义：设了标识色的机器任何状态都显示机器色；无色机器
      已连接=绿 / 连接中·测试中·重连中=琥珀 / 已放弃=红 / 其余=灰；
      未连接行整体 60% 透明度。
- [ ] 状态文案随轮询刷新（连接中→已连接；重连中（含下次重试）/已放弃）。
- [ ] 已放弃机器行悬停可见 lastError 原因（title 提示）。
- [ ] 点击已连接机器：内容区立即切到该机器（触发按钮显示机器名+色点）。
- [ ] 点击未连接机器：发起连接，就绪后自动切换（不闪空端口页）。
- [ ] 点击「本地」：回本地实例（远端连接保持）。
- [ ] 空态（无机器）：菜单出现引导文案；「管理机器」点击弹 toast 指路
      web 设置页 SSH 面板。

## B 内容区与着色

- [ ] 连接勾选了 tintBorder+标识色的机器：内容区四周出现 2px inset ring
      （机器色），切换回本地后消失。
- [ ] 未勾 tintBorder 或无标识色：不描边。
- [ ] 远端模式下 iframe 内 web 界面可正常交互（含其设置页 SSH 面板）。

## C 弹窗桥命令（web 设置页 SSH 面板内）

- [ ] 桌面 iframe 内打开 web 设置页 SSH 面板：机器卡片出现「新窗口打开」
      按钮（remote_bridge_ping 探测成功）。
- [ ] 点击后打开独立窗口（标题 `DSH Remote · <machineId>`，1280×840），
      加载隧道 URL 的远端 web 界面；再次点击聚焦已有窗口（不重复开窗）。
- [ ] 同一面板在纯浏览器打开（直接访问服务 URL）：按钮隐藏（探测超时）。

## D 降级与恢复（验收标准 3）

- [ ] 停掉本地实例（设置里 Stop 服务或杀进程）：切换器下拉出现
      「本地实例不可达」提示，机器项禁用（半透明、不可点），不弹错误弹窗。
- [ ] 重启实例并聚焦窗口：提示消失、机器项恢复可点。
- [ ] 降级期间既有机器列表不清空。

## E 断线自动恢复（S3 联动，GUI 观察）

- [ ] 活动机器被服务端掐线（远端重启 sshd / 断网）：切换器显示「重连中」，
      内容区保持指向该机器（隧道 URL 粘性，不出空端口）。
- [ ] 恢复后自动回到「已连接」，界面随之可用（无需手动刷新）。
- [ ] 主动断开（面板 Disconnect）：视图自动回本地，切换器状态点变灰。

## F macOS 平台（如适用）

- [ ] 弹窗窗口从 Tauri 命令创建在 macOS 正常（尺寸/聚焦/Dock 图标）。

## 附：已自动化项索引

| 验收点 | 证据 |
|---|---|
| 1 壳层验证 | `cargo test` 448 绿（含 bridge/remote 3 例 + capability 2 例）；`pnpm typecheck` 绿；`pnpm test` src 455 例绿（新增 28）；`pnpm lint` 无新增（较基线 -1） |
| 2 数据面全旅程 | `docs/testing/s5-ssh-e2e-evidence.md`（dev 真机 ALL STEPS PASSED） |
| 4 capability 复核 | `builder.rs security_tests::remote_popup_windows_are_scoped_by_glob_and_stay_loopback`；白名单仅增 `remote_bridge_ping`/`remote_open_window`；命令侧回环 http 校验单测 |
| 5 旧概念残留 | `Setting.remotes`/`remote_machine_*`/`remote-status` 等关键词全仓 grep 零命中（仅余 git-remote 无关词） |
| 切换器/轮询/着色/降态逻辑 | `src/store/modules/remote/*.test.ts`（22 例）+ `remote-switcher.test.tsx`（6 例） |
