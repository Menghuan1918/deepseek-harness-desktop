import semver from 'semver'

/**
 * 核心(dsh)版本判断：以 rc.2 为硬编码基准，高于该基准的版本引入破坏性更改、
 * 可能影响第三方插件。该判断与「推荐版本」逻辑无关，仅作为用户提示的阈值。
 */
export const CORE_BREAKING_BASELINE = '0.1.2-rc.1'

/** 剥掉 release tag 的 `dsh-`/`src-` 前缀（含重复的 `dsh-src-` 链）后再交给 semver */
function stripVersionPrefix(version: string): string {
  let value = version
  while (value.startsWith('dsh-') || value.startsWith('src-'))
    value = value.replace(/^(?:src|dsh)-/, '')
  return value
}

/**
 * Semver comparison using the `semver` package.
 * Handles `dsh-`/`src-` prefixes (including repeated `dsh-src-` chains) by
 * stripping before comparison; unparsable values compare as equal.
 * Returns: negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = semver.parse(stripVersionPrefix(a))
  const pb = semver.parse(stripVersionPrefix(b))
  if (!pa || !pb)
    return 0
  return semver.compare(pa, pb)
}

/** 主/次版本号（`x.x`，不含 patch 与预发布标识）；缺失或不可解析时为空串 */
export function coreMajorMinor(version: string): string {
  const parsed = semver.parse(stripVersionPrefix(version))
  return parsed ? `${parsed.major}.${parsed.minor}` : ''
}

/**
 * 目标核心是否相对当前核心跨了主/次版本（patch 升级不算）。
 *
 * 核心与档案是配套的：跨主/次版本意味着破坏性更改，切换前必须把当前档案换成配套档案。
 * 不可解析（本地核心版本号缺失、首次切换没有在用核心）一律返回 false——漏提示只是少了
 * 一次提醒，误判会把正常切换挡在弹窗后面。
 */
export function isCoreMajorMinorUpgrade(from: string, to: string): boolean {
  const current = semver.parse(stripVersionPrefix(from))
  const target = semver.parse(stripVersionPrefix(to))
  if (!current || !target)
    return false
  return semver.gt(target, current)
    && (target.major !== current.major || target.minor !== current.minor)
}

/** 判断核心版本（版本串或 release tag）是否高于 rc.2 基准（引入破坏性更改） */
export function isCoreBreakingVersion(version: string): boolean {
  return !!version && compareVersions(version, CORE_BREAKING_BASELINE) > 0
}

/**
 * 最低支持的核心版本（与 Rust `MIN_SUPPORTED_CORE_VERSION` 对齐）。低于它的核心缺少
 * 内置插件依赖的平台种子词，随包插件必然加载失败并把应用卡在启动阶段（issue #596）。
 *
 * 这是兼容性的唯一基线：它低于推荐核心版本（`manifest.jsonc` 的 `engines.dsh.recommend`，仅用于更新
 * 提示），两者不可混用——拿推荐版本当基线会把「高于基线、低于推荐版本」的可用核心
 * 误判为不兼容（推荐版本为 0.1.7-alpha.1 时，0.1.5-rc.3 就是这么被挡下的）。
 */
export const MIN_SUPPORTED_CORE_VERSION = '0.1.5-rc.1'

/**
 * 核心版本是否低于最低支持基线（按版本判定，与来源无关）。
 *
 * 版本缺失或不可解析时返回 false（`compareVersions` 对不可解析值返回 0）——漏放行只是
 * 回到修复前的行为，误判会把可用的核心归进「不兼容」分组。
 */
export function isCoreUnsupported(version: string): boolean {
  return compareVersions(version, MIN_SUPPORTED_CORE_VERSION) < 0
}
