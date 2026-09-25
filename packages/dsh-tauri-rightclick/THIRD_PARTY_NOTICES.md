# Third-party notices

## deepseek-ai/deepseek-harness

This package carries no official source. Its native-style context menu is this
repo's own feature; where an action already exists officially it is delegated to
the official implementation first, with the plugin's own path as fallback.
Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Integration points:

- **Official primitives popovers** — menus and toasts run on the official
  primitives `Menu`; the plugin only adds host capabilities and extra items
  (`src/client/register/context-menu.tsx:46`). Shortcut hints reuse the official
  menu item shape, which accepts `ReactNode` (`context-menu.tsx:32`).
- **Official actions first** — rename, archive and fork call the official
  implementation with the service instance as receiver and fall back only when
  it is unavailable (`src/client/service/menu.ts:43,63,102,111`); pinning is
  offered only when the kernel provides it (0.1.7+), and older kernels hide the
  entry instead of emulating it (`menu.ts:77,90`).
- **Official menu/row location** — menu items and inline row action buttons are
  located through their official text and ARIA shape
  (`src/client/register/official-menu.ts:8`, `src/client/register/locate.ts:40,107`),
  including the official React-rendered action button that appears after hover.
- **Official service surface** — `src/client/types/index.ts:21,29,33` extends the
  official sessions / workspaces services with the capabilities this menu needs
  (`open` was removed in kernel 0.1.7 and is restored by the adapter compat
  bridge; the pinned-session set exists from 0.1.7).

## License

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
