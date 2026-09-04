/**
 * Host-runtime compile-time declarations for the modules this plugin's client
 * bundle requires through the DSH module table (the scheduler-plugin
 * precedent): the desktop invoke bridge re-exported by `dsh-tauri/client`.
 * No runtime dependency is declared — the loader resolves the specifier
 * against the module table (see the `dsh-tauri` inject entry in
 * package.json), so these mirrors exist purely for `tsc`.
 */

declare module 'dsh-tauri/client' {
  /**
   * Call one Tauri command through the desktop iframe invoke bridge; the
   * promise rejects on a command error or when the host never answers
   * (timeout — i.e. this page is not embedded in the desktop shell).
   */
  export function invokeBridgedTauri<T>(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<T>
}
