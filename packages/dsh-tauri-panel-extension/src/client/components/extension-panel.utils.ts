/**
 * client/components/extension-panel.utils.ts — 扩展面板标签页的取舍判据。
 *
 * 市场标签页是**可选**的：它由另一个客户端插件在渲染期探测发布（`service/market.ts`），
 * 插件更新/重载期间服务会短暂消失。`useState` 的初值只取一次，若活动页直接沿用请求值，
 * 市场消失后过滤结果为空——一行都不渲染，面板变成空白页（issue #655）。
 */

/** 判据只读 `id`：调用方传业务行即可，不必为工具层再造一个类型。 */
export function resolveActiveTab(rows: readonly { id: string }[], requested: string): string {
  return rows.some(row => row.id === requested) ? requested : rows[0]?.id ?? requested
}
