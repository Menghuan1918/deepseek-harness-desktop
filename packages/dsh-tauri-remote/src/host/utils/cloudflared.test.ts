import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { cloudflaredAsset, cloudflaredDownloadUrls, fetchCloudflaredRelease, isCloudflaredVersion, parseQuickTunnelUrl, quickTunnelArgs, resolveCloudflared, tokenTunnelArgs, tokenTunnelEnv } from './cloudflared'

describe('cloudflared 平台表', () => {
  it('覆盖受支持的平台组合', () => {
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({ asset: 'cloudflared-darwin-arm64.tgz', executable: 'cloudflared', archive: true })
    expect(cloudflaredAsset('darwin', 'x64')).toEqual({ asset: 'cloudflared-darwin-amd64.tgz', executable: 'cloudflared', archive: true })
    expect(cloudflaredAsset('linux', 'x64')).toEqual({ asset: 'cloudflared-linux-amd64', executable: 'cloudflared', archive: false })
    expect(cloudflaredAsset('linux', 'arm64')).toEqual({ asset: 'cloudflared-linux-arm64', executable: 'cloudflared', archive: false })
    expect(cloudflaredAsset('win32', 'x64')).toEqual({ asset: 'cloudflared-windows-amd64.exe', executable: 'cloudflared.exe', archive: false })
  })

  it('不支持的平台没有资产，调用方据此给出可读错误', () => {
    expect(cloudflaredAsset('linux', 'arm')).toBeUndefined()
    expect(cloudflaredAsset('freebsd', 'x64')).toBeUndefined()
  })
})

describe('下载源与命令行', () => {
  it('按已解析的 tag 拼官方直链，镜像前缀透传原地址', () => {
    const urls = cloudflaredDownloadUrls('cloudflared-linux-amd64', '2026.10.0')
    expect(urls).toEqual([
      'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64',
      'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64',
    ])
  })

  it('cLOUDFLARED_VERSION 固定版本时地址与摘要都按该版本取', () => {
    const urls = cloudflaredDownloadUrls('cloudflared-darwin-arm64.tgz', '2026.10.0', '2026.9.0')
    expect(urls[0]).toBe('https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-darwin-arm64.tgz')
  })

  it('官方发布元数据缺失 sha256 摘要时拒绝执行', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: '2026.10.0', assets: [{ name: 'cloudflared-linux-amd64', size: 1 }] }), { status: 200 })) as typeof fetch
    try {
      await expect(fetchCloudflaredRelease('cloudflared-linux-amd64')).rejects.toThrow('sha256')
    }
    finally {
      globalThis.fetch = original
    }
  })

  it('官方发布元数据解析出 tag 与摘要', async () => {
    const original = globalThis.fetch
    const digest = `sha256:${'a'.repeat(64)}`
    globalThis.fetch = (async () => new Response(JSON.stringify({ tag_name: '2026.10.0', assets: [{ name: 'cloudflared-linux-amd64', digest, size: 42 }] }), { status: 200 })) as typeof fetch
    try {
      await expect(fetchCloudflaredRelease('cloudflared-linux-amd64')).resolves.toEqual({ tag: '2026.10.0', digest, size: 42 })
    }
    finally {
      globalThis.fetch = original
    }
  })

  it('quick 模式指向本机隧道入口且关闭自动更新', () => {
    expect(quickTunnelArgs('http://127.0.0.1:3089')).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3089'])
  })

  it('具名隧道的凭据走环境变量，不出现在进程参数里', () => {
    expect(tokenTunnelArgs()).toEqual(['tunnel', '--no-autoupdate', 'run'])
    expect(tokenTunnelEnv('cf-token')).toEqual({ TUNNEL_TOKEN: 'cf-token' })
    expect(tokenTunnelArgs().join(' ')).not.toContain('cf-token')
  })
})

describe('下载校验', () => {
  it('摘要不匹配时拒绝执行，且不写出可执行文件', async () => {
    const originalFetch = globalThis.fetch
    const home = mkdtempSync(join(tmpdir(), 'dsh-cloudflared-verify-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes('api.github.com'))
        return new Response(JSON.stringify({ tag_name: '2026.10.0', assets: [{ name: cloudflaredAsset()?.asset, digest: `sha256:${'f'.repeat(64)}`, size: 4 }] }), { status: 200 })
      return new Response(Buffer.from('junk'), { status: 200, headers: { 'content-length': '4' } })
    }) as typeof fetch
    try {
      await expect(resolveCloudflared()).rejects.toThrow('SHA-256 校验失败')
      expect(existsSync(join(home, 'remote', 'bin', cloudflaredAsset()?.executable ?? ''))).toBe(false)
    }
    finally {
      globalThis.fetch = originalFetch
      if (previousHome === undefined)
        delete process.env.DSH_HOME
      else
        process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('日志解析', () => {
  it('从 cloudflared 的日志行里取出 quick 隧道域名', () => {
    expect(parseQuickTunnelUrl('INF Your quick Tunnel has been created! Visit it at https://bold-fox-abc.trycloudflare.com'))
      .toBe('https://bold-fox-abc.trycloudflare.com')
    expect(parseQuickTunnelUrl('INF |  https://plain-host.trycloudflare.com  |')).toBe('https://plain-host.trycloudflare.com')
  })

  it('不把其它地址当隧道域名', () => {
    expect(parseQuickTunnelUrl('INF Cannot reach https://api.cloudflare.com/client/v4')).toBeUndefined()
    expect(parseQuickTunnelUrl('INF http://bold-fox-abc.trycloudflare.com')).toBeUndefined()
    expect(parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined()
  })

  it('只认 cloudflared 的版本行', () => {
    expect(isCloudflaredVersion('cloudflared version 2026.1.0 (built 2026-01-02-1200)')).toBe(true)
    expect(isCloudflaredVersion('cloudflared version 2026.1.0')).toBe(true)
    expect(isCloudflaredVersion('command not found: cloudflared')).toBe(false)
    expect(isCloudflaredVersion('cloudflared version unknown')).toBe(false)
  })
})
