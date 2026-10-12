import type { RemoteAuthScope, RemotePasswordRecord, RemoteTunnelConfig, RemoteTunnelStatus } from '../types/index'

export interface RemoteAccessListen {
  address: string
  port: number
}

export interface RemoteAccessAuthDocument {
  enabled: boolean
  password: RemotePasswordRecord | null
  token: string | null
  scope: RemoteAuthScope
}

export interface RemoteAccessDocument {
  version: number
  enabled: boolean
  listen: RemoteAccessListen
  auth: RemoteAccessAuthDocument
  tunnel: RemoteTunnelConfig
}

/** `POST /access` 请求体：字段缺省表示保持原值（`password` 只写，`null` 表示清除已设密码）。 */
export interface RemoteAccessBody {
  enabled?: boolean
  address?: string
  port?: number
  authEnabled?: boolean
  scope?: RemoteAuthScope
  password?: string | null
}

export type RemoteLinkSource = 'loopback' | 'lan'

export type RemoteAccessState = 'stopped' | 'listening' | 'error'

export type RemoteAddressFamily = 'ipv4' | 'ipv6'

export type RemoteAddressScope = 'loopback' | 'private' | 'public' | 'link-local'

export interface RemoteAccessAddress {
  address: string
  family: RemoteAddressFamily
  interface: string
  scope: RemoteAddressScope
  score: number
  recommended: boolean
}

export type RemoteAccessEventKind = 'state' | 'auth' | 'token'

export interface RemoteAccessEvent {
  seq: number
  ts: string
  kind: RemoteAccessEventKind
  line: string
}

/** 临时配对码：宿主生成、5 分钟轮换；分享链接与二维码只携带它，永久凭据不出现在分享物里（评审意见 6）。 */
export interface RemoteAccessPairing {
  code: string
  expiresAt: number
  link: string
  qr: string
  /** 隧道就绪时附带的同一临时码公网链接与二维码；隧道未运行则缺省。 */
  tunnelLink?: string
  tunnelQr?: string
}

export interface RemoteAccessStatus {
  version: number
  enabled: boolean
  state: RemoteAccessState
  listening: boolean
  /** 配置值：选定地址与首选端口（回落时保持首选值不变）。 */
  listen: RemoteAccessListen
  /** 真实监听端口；未监听时为 0。 */
  port: number
  auth: { enabled: boolean, scope: RemoteAuthScope, hasPassword?: boolean, hasToken?: boolean }
  addresses: RemoteAccessAddress[]
  recommended?: string
  /** 完整链接（含链接 Token）；仅回环来源可见。 */
  link?: string
  /** 掩码链接：主机与端口可见、Token 隐藏；非回环来源仅此一项。 */
  maskLink?: string
  /** 链接的二维码 dataURL（回环监听也生成：面板用于本地核对与演示）。 */
  qr?: string
  /** 链接归属：回环监听 = 仅本机可用，网卡监听 = 局域网可用。 */
  linkSource?: RemoteLinkSource
  /** 临时配对码与其分享链接/二维码；仅回环来源可见。 */
  pairing?: RemoteAccessPairing
  /** 本次请求刚自动生成的访问密码明文：只在响应里出现一次，不落盘、不进事件环。 */
  generatedPassword?: string
  /** 公网隧道读面：配置 + 运行期状态（完整分支才带 Token 与链接二维码）。 */
  tunnel?: RemoteTunnelStatus
  localPort?: number
  error?: string
  warnings?: string[]
  events: RemoteAccessEvent[]
}

export interface RemoteAccessParse {
  document: RemoteAccessDocument
  corrupt: boolean
  warnings: string[]
}
