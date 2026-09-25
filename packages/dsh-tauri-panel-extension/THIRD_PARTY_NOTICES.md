# Third-party notices

Substantial portions of the Skills and MCP manager are adapted from
[`qinyre/dsh-plugin-capabilities`](https://github.com/qinyre/dsh-plugin-capabilities)
at commit `3412f8ddf0a92bdc89a3bab104b480f8745ebfc1`.

Copyright (c) 2026 qinyre. Used and modified under the MIT License. The full
upstream source and license are retained as the Git submodule at
`source/dsh-plugin-capabilities`.

The packaged `skills/skill-creator` files originate from
[`anthropics/skills`](https://github.com/anthropics/skills) under Apache-2.0;
its `LICENSE.txt` is retained. The packaged `skills/find-skills` files originate
from [`vercel-labs/skills`](https://github.com/vercel-labs/skills) under MIT;
its `LICENSE` is retained.

## deepseek-ai/deepseek-harness

The Skills and MCP manager is built **on top of** the official Host plugins for
the same features: it drives their contracts and configuration instead of
re-implementing them, so no official source file is copied into this package.
Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Integrated official contracts:

- **Skills provider** — `src/host/service/provider.utils.ts` imports the official
  `@deepseek-ai/dsh-skill-filesystem` plugin through the platform loader and
  `src/host/service/provider.ts` re-mounts it with `customSkillDirs` = packaged
  `skills/` directory + managed skill roots + agent roots. The per-skill
  enable/disable switch calls the official provider's `setPolicy(path, enabled)`
  (`src/host/routes/skill/policy/post.ts`).
- **Skill format and roots** follow the official contract: a `SKILL.md` directory
  bundle or a flat `<name>.md` file with YAML frontmatter, scanned in the
  official project/custom/user priority order, including the official `user-dsh`
  root `<DSH_HOME>/skills`.
- **MCP** — every row the editor writes into `cordis.patch.yml` is an official
  `@deepseek-ai/dsh-mcp-client` instance (`MCP_PLUGIN` in
  `src/host/config/constants.ts`) using the official `serverName` / `transport` /
  `command` / `args` / `env` / `cwd` or `url` / `headers` config shape. This
  package is only the configuration surface for those instances, and the editor
  intentionally exposes a subset of the official config: the official
  `toolCallTimeoutMs`, `failOnStartupError`, `maxInstructionBytes` and
  `reconnect` keys are not surfaced yet.
- **MCP resources** are left to the official `@deepseek-ai/dsh-mcp-resources`
  plugin that the kernel mounts; this package adds no resource tooling.

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
