# Third-party notices

Substantial portions of the scheduled-task panel are adapted from
[`MichengAI/dsh-automation`](https://github.com/MichengAI/dsh-automation)
(`@michengai/dsh-automation`) at the adopted baseline commit
`f1bc91a3437f0b952631a46a8363089587b9ae6a` (`v0.1.32`), plus the DSH `0.1.5-rc.1`
host-compatibility follow-up from upstream `c426c3d` (`v0.1.35`):

- **Host, unattended execution** — `src/host/service/executor.ts` (aligned
  line-by-line with upstream `src/executor.ts`, `executeAutomationRun`),
  `src/host/service/permission-presets.ts`, `src/host/service/options.ts`,
  `src/host/types/index.ts`.
- **Client** — `src/client/components/menu.tsx` + `menu.cssr.ts`,
  `src/client/components/model-picker.tsx` + `model-picker.cssr.ts`,
  `src/client/components/task-create-dialog.tsx`,
  `src/client/components/prefill-bridge.tsx`, `src/client/prefill.ts`,
  `src/client/register/prefill.ts`, `src/client/types/scheduler.ts`,
  `src/client/types/protocol.ts` (structure, interaction and ARIA copied from the
  upstream menu / model picker / chat-prefill bridge).

Copyright 2026 MichengAI contributors. These portions are used and modified under
the Apache License, Version 2.0. Adapted files carry an inline attribution
comment at the top.

The full upstream source, license and NOTICE are retained as the Git submodule at
`source/dsh-automation`. The scope of the adaptation, the deliberately retained
differences and the verification history are recorded in
[`docs/sync-log.md`](./docs/sync-log.md).

## Retained upstream NOTICE

Reproduced verbatim from the upstream `NOTICE` file, as required by Apache-2.0
§4(d):

```text
dsh-automation
Copyright 2026 MichengAI contributors

本项目的 TypeScript 源码、构建脚本与项目文档采用 Apache License 2.0。

产品模型参考了 DeepSeek Harness 社区中的独立自动化实践：
- 独立 Session 调度与审计历史 (titanwings/dsh-automation，MIT)

上述参考实现的许可证与版权仍归其原作者所有；本仓库实现为独立编写，不复制其专有代码。
```

## deepseek-ai/deepseek-harness

The scheduled-task panel is **not** derived from official source. It is the
desktop counterpart of the official Schedule plugin and runs on the official
Host contracts below. Upstream sources are MIT-licensed:

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Cross-checked revision: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`
  (`dsh-v0.1.7-alpha.1` — the `source/deepseek-harness` gitlink and the `dsh:`
  catalog pin in `pnpm-workspace.yaml`)
- Bundled runtime cross-check: `477b4f420553e8a52c2fbccc464d7561b239c443`
  (`dsh-v0.1.7-rc.2`)
- License: MIT — Copyright (c) 2026 DeepSeek

Official Host packages used at runtime (`src/host/utils/agent-runtime.ts`
imports the first three dynamically; the rest are declared dependencies):

| Official package | What is used |
| --- | --- |
| `@deepseek-ai/dsh-agent` | `installModelSelection` |
| `@deepseek-ai/dsh-llm` | `createUserMessage` |
| `@deepseek-ai/dsh-user-approval` | `setApprovalPolicy` |
| `@deepseek-ai/dsh-session` | Session creation/append for an unattended run |
| `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-workspace` | Tool registration and workspace resolution |

Feature counterpart (official `@deepseek-ai/dsh-schedule` +
`@deepseek-ai/dsh-client-ui-schedule` → this package):

| Official | This package | Difference |
| --- | --- | --- |
| Model tools `schedule_create` / `schedule_list` / `schedule_delete` / `schedule_update` in live root Agent scopes | Model tools `scheduler_create` / `scheduler_list` / `scheduler_toggle` / `scheduler_delete` / `scheduler_run_now` (`src/host/tools/`) | Separate names, five tools instead of four |
| Durable Host-wide reminders delivered as follow-up messages in their **original** Session | Unattended runs, each starting a **fresh** Session in a chosen workspace (`workspaceId`, `permission`, `provider`, `model`, `reasoningEffort`) | Delivery target differs by design |
| One-shot, fixed-rate, daily, weekly and cron wall-clock recurrence (`createCronScheduleRecord`, `resolveCronOccurrence`, `canonicalizeCronExpression`) | `once` / `hourly` / `daily` / `interval` / `workdays` / `weekly` / `monthly` / `custom` (`SCHEDULE_KINDS` in `src/shared/constants.ts`), evaluated with the `cron-schedule` package or anchored arithmetic | No cron kind; extra workdays/monthly/anchored kinds |
| Each recurring task contributes only its latest missed occurrence; the Host restores a cold Session when delivery is due | Anchored interval/custom arithmetic plus `runs/recover` reconciliation for interrupted runs | Different missed-occurrence policy |
| Task list, task detail, delivery history, clock/date pickers and recent time zones in the management page | Scheduler panel with task list, create dialog, run history (`history/{get,delete}`) | Comparable, no delivery history or time-zone data source |

Both official rows ship `disabled: true` in the `@deepseek-ai/dsh-web-app`
bundle (`cordis.patch.yml`: id `schedule`, id `ui-schedule`), so the official
Schedule service and this plugin do not run against the same task store by
default.

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
