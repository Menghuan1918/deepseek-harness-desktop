# Third-party notices

## deepseek-ai/deepseek-harness

This package is a development-only playground and carries no official source.
It renders the component registry of `dsh-tauri-ui` and therefore shows, but
does not copy, official client UI components. Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Official surface referenced:

- The playground documents the `reexport` (official implementation forwarded as
  is, styles from the official CSS Modules) and `refork` (official CSS
  reproduced locally because only the newer kernel implements or exports the
  component) distinctions of the `dsh-tauri-ui` registry, including the official
  class each refork maps to (`src/client/ui/components-playground/ui-components.tsx:112,128-130,252`).
- Official `Menu` is wired into the chip triggers so selection state, chevron
  rotation and popover placement behave like the shipped UI
  (`ui-components.tsx:57`); two kernel generations export the official icons
  barrel under different names, so icons are consumed through `@gravity-ui/icons`
  re-exported by `dsh-tauri-ui/client` (`ui-components.tsx:262`).

See `packages/dsh-tauri-ui/THIRD_PARTY_NOTICES.md` for the derivation table of
those official components.

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
