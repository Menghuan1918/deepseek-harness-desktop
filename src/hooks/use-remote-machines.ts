import { useEventListener, useMount } from '@reause/core'
import { store } from '@/store'

/**
 * 远端机器数据面的组件侧装配：启动轮询（store 内幂等）并挂「窗口聚焦 /
 * 页面可见」触发的即时刷新。卸载时只摘监听——轮询属于壳层生命周期，由
 * store 持有（StrictMode 双挂载下 boot 只执行一次）。
 */
export function useRemoteMachines(): void {
  useMount(() => store.remote.boot())

  function refreshNow() {
    if (!document.hidden)
      void store.remote.refresh()
  }

  useEventListener('focus', refreshNow)
  useEventListener(document, 'visibilitychange', refreshNow)
}
