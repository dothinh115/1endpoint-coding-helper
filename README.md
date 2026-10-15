# @1endpoint/coding-helper

Safe, isolated setup for **DeepSeek Harness** and **Claude Code CLI** using the single 1endpoint API base URL:

```text
https://1endpoint.dev/api/v1
```

**Release status: not yet published to npm.** The following registry commands become available only after the maintainer publishes the package. Until then, run the local executable or a reviewed tarball. This helper is an independent integration, not an official DeepSeek or Anthropic product.

## Requirements

- Node.js **22.19 or newer** (tested locally on Node 24).
- Install the desired coding tool separately from its official distribution. The helper does not download tools or run installation scripts.
- An enabled public model ID from the [1endpoint model catalog](https://console.1endpoint.dev/models).
- Set `ONEENDPOINT_API_KEY` in the launching process environment using your shell or secret manager. Never put the key in command arguments, a Git repository, or a shared configuration file.

## Setup

After publication:

```bash
npx @1endpoint/coding-helper
# First choose English / Tiếng Việt, then the action.
# Colorful menu: use ↑/↓ and Enter; Escape cancels. No typed y/n.
# Setup, reconfigure, remove, diagnose and run are available in the menu.
# Fetches public 1endpoint text models for selection; Claude tiers map independently.
# Or explicit, scriptable setup:
npx @1endpoint/coding-helper setup --tool dsh --model your-model-id --dry-run
npx @1endpoint/coding-helper setup --tool dsh --model your-model-id
npx @1endpoint/coding-helper setup --tool claude --model your-model-id
```

Before publication, from the repository:

```bash
yarn install --immutable
yarn test
node src/cli.mjs setup --tool dsh --model your-model-id --dry-run
node src/cli.mjs setup --tool dsh --model your-model-id
```

**After setup or reconfigure, restart the DSH/Claude Code session for changes to take effect. An already-open session does not update automatically. Start the new session through `coding-helper run`, not the original tool command, to use the isolated helper profile.**

The wizard begins with **English / Tiếng Việt** selection before configuration/reconfiguration/deletion. It fetches the public 1endpoint text model catalog for arrow-key choices. Claude's Haiku, Sonnet and Opus tiers can each map to a different public model; optional Fable mapping is available for versions supporting that tier. The helper does not infer vendor/model equivalence from names. If catalog loading fails, choose Retry, explicit manual ID entry, or Cancel.

Setup never asks for, reads, validates or stores your API key. It creates only helper-owned files under `~/.1endpoint/coding-helper`. Use an absolute `ONEENDPOINT_HELPER_HOME` to choose a different state directory. Dry-run makes no writes. Existing DSH and Claude user configuration is not edited or imported.

## Diagnose and launch

After setting the key in your process environment:

```bash
coding-helper doctor --tool dsh
coding-helper run --tool dsh
coding-helper run --tool dsh --profile headless -- 'Reply exactly OK'
coding-helper doctor --tool claude
coding-helper run --tool claude
coding-helper run --tool claude -- -p 'Reply exactly OK'
```

For npx-only use, replace `coding-helper` with `npx @1endpoint/coding-helper`. For local use, replace it with `node src/cli.mjs`.

`doctor` verifies owned-file integrity, CLI availability and whether the key environment variable is present. It does **not** validate credentials, make network requests, call inference, execute an apiKeyHelper or read your original tool credentials. `run` is explicit consent to launch the selected tool; tool startup and inference can contact networks and incur charges. Permission/trust prompts remain tool-owned. Authentication, provider health and real inference are separate from local configuration tests.

### DeepSeek Harness

- Uses a separate `DSH_HOME` plus a dedicated `--patch` overlay.
- Configures the native `llm-pi-ai` provider with `api: openai-completions`, `baseURL` and `apiKeyEnv: ONEENDPOINT_API_KEY`.
- Configures the native `agent-default-model` selection. No secret interpolation, custom proxy or injected agent instruction is required.
- Supported profiles: `web`, `headless`, `acp`, `sdk`. `sdk-minimal` lacks the required entries and is deliberately rejected.
- The helper does not reuse current sessions, plugins, model presets or provider configurations. Existing sessions can retain their own model selection; start a new session in the isolated profile.
- DSH owns request assembly, conversation state, streaming, tool loops and permissions. The helper only sets the connection.
- Verified configuration contract: DSH `0.2.1-alpha.3`. This prerelease contract may change. A successful dump exit code alone is insufficient: the integration tests also inspect provider and selected-model rows. The shipped Web schema dump has a separate preset/tree-carrier failure; headless schema validation is the supported check.

### Claude Code CLI

- Uses a separate `CLAUDE_CONFIG_DIR`, a helper-owned `--settings` file and `--setting-sources user`.
- **Project and local settings, including their hooks and permissions, are intentionally not loaded.** This is a tradeoff for deterministic routing, not transparent preservation of project behavior. Managed/organization policy still applies and can override the connection. Do not use this mode if those project restrictions are required; configure the tool manually with your administrator instead.
- The raw process key becomes `ANTHROPIC_AUTH_TOKEN` in the child environment only. The CLI constructs the Bearer header. No key is written to settings or included in argv.
- Maps main, Opus, Sonnet, Haiku, optional Fable and default subagent roles. The wizard offers distinct catalog selections per tier; scripted setup accepts `--haiku-model`, `--sonnet-model`, `--opus-model` and optional `--fable-model`. `--model` is the main/default fallback; explicit role selections take priority. Without a Fable mapping it follows the Opus selection. Explicit model IDs in agent/skill definitions or managed policy are outside that default mapping; no promise is made to rewrite every model choice.
- Clears inherited conflicting Anthropic/cloud authentication and routing variables in the child only. It does not log out, modify the parent's environment, bypass permission prompts or execute existing key helpers.
- Uses the same universal base URL above. Claude appends `/v1/messages`, producing `/api/v1/v1/messages`, a supported gateway alias. Do not change the base to a different per-client URL.
- Claude owns request assembly, conversation state, streaming and tool execution. Version verification and fixture boundaries are recorded in the release checklist.

## Update, backup and recovery

```bash
coding-helper backup --tool dsh
coding-helper reconfigure --tool dsh --model another-public-model --dry-run
coding-helper reconfigure --tool dsh --model another-public-model
coding-helper remove --tool dsh --dry-run
coding-helper remove --tool dsh --yes
```

`reconfigure` validates the unchanged helper manifest/configuration, automatically backs up the verified old connection configuration and changes the model. Legacy `setup --update` is also available. Backups contain only generated configuration, never keys. Identical setup is idempotent. Normal setup refuses unknown files, modified configuration, malformed manifests and symlink state paths. Writes use an exclusive setup lock, private file permissions and atomic replacement; failed configuration writes attempt rollback.

`remove` previews with `--dry-run` and requires explicit `--yes` to delete the selected tool's generated connection file and manifest. It preserves runtime homes, conversations, backups, unrelated files and all original tool settings. **Stop the corresponding tool before removing its connection configuration.** To return to normal tools, launch `dsh` or `claude` directly without the helper.

For corrupted or hand-modified helper configuration, use `coding-helper remove --tool dsh --force --yes` (or `claude`), then run setup again. Force recovery targets only the fixed helper-generated connection file and manifest, never paths read from a damaged manifest; it does not copy potentially secret-bearing tampered content into backups. Symlinks remain refused even in force mode. There is no need to find and delete configuration files manually. Runtime homes may contain tool-created conversations or credentials; they are intentionally retained, not silently wiped or backed up. Do not share or commit them. A stale setup lock still requires reviewing that no setup is active before retrying; do not defeat a live writer lock.

This is configuration isolation, **not an OS sandbox**. The coding tools still have their ordinary filesystem/network access and can create runtime data. No unattended install, background daemon, automatic paid smoke, telemetry or global config migration is included.

## Development and packaging

```bash
yarn install --immutable
yarn check
yarn test
yarn pack --out ../coding-helper-0.1.0.tgz
```

No production dependencies and no build step. The published entry is native ESM. Package contents are allowlisted. See the [publishing guide](docs/PUBLISHING.md) for step-by-step npm authentication, first publication, verification, updates and troubleshooting. See the [release checklist](docs/RELEASE.md) for current verification boundaries. Publishing is a separate maintainer action; creating or pushing the repository does not publish npm.

## Reference and attribution

The onboarding/product design was reviewed against [Z.AI coding-helper](https://www.npmjs.com/package/@z_ai/coding-helper) `0.1.1`: wizard, per-tool setup and doctor. Its registry metadata labels the package Proprietary. No implementation code is copied; this is an independent implementation with an explicit test suite, no stored API keys, and no automatic tool installation. The reference has no DSH support and is not authority for the DSH configuration contract.

Official references: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Claude gateway setup](https://code.claude.com/docs/en/llm-gateway-connect), [settings](https://code.claude.com/docs/en/settings), [models](https://code.claude.com/docs/en/model-config).

## Tiếng Việt

Helper hỗ trợ ưu tiên DeepSeek Harness và Claude Code CLI; dùng một base URL chung, home riêng và API key từ biến môi trường. Không sửa cấu hình công cụ đang dùng, không lưu key, không tự cài công cụ và không tự gọi inference có phí. `setup --dry-run` xem trước; `doctor` chỉ kiểm tra cục bộ; `run` mới khởi chạy công cụ. Claude chạy ở chế độ này **không nạp settings/hook/quyền project-local**; chính sách quản trị vẫn có hiệu lực. Package chưa publish: dùng lệnh local ở trên cho tới khi maintainer phát hành. Hướng dẫn Console có cả EN/VI.
