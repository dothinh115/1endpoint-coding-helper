# @1endpoint/coding-helper

Connect **Codex**, **DeepSeek Harness (DSH)**, **Claude Code**, **OpenClaw** or **Hermes** to 1endpoint with an interactive setup menu. Choose your language and models without editing configuration files by hand, then use the coding tool normally.

## Before you start

- Install **Node.js 22.19 or newer**.
- Install the tool you want to configure first: [Codex](https://learn.chatgpt.com/docs), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Claude Code](https://code.), [OpenClaw](https://docs.openclaw.ai/start/getting-started) or [Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/installation). Follow its own runtime requirements too. The helper configures tools; it does not install them.
- Have a 1endpoint API key ready. Keep it private: do not paste it into command arguments, shared configuration files or a repository.

## 1. Set up your tool

Run this in your terminal:

```bash
npx @1endpoint/coding-helper
```

1. Choose **English** or **Tiếng Việt**.
2. Choose **Setup**.
3. Select the tool you want to configure. Before Setup or Reconfigure continues, the helper checks for the selected executable on `PATH`. If it is missing, install the tool using the displayed official guide, reopen your terminal and run the helper again. No key is requested or configuration written while this check fails.
4. Paste your key into the **masked API-key prompt**, or select **Open Console** and press Enter to create one first. If a saved key is available, choose **Use an existing key** to reuse it.
5. Select models from the 1endpoint catalog.
6. Review the selection, then choose **Confirm**. The key is saved automatically and the tool's native user configuration is updated.

Use **↑ / ↓** to move and **Enter** to select. Press **Escape** to cancel. Confirmation is a selection, not a typed `y/n` answer.

Most text uses your terminal's default color. Cyan marks the current choice, yellow marks warnings, and red marks errors or exceptional destructive choices such as force recovery and deleting a saved key. The `❯` marker and explicit labels also work without color. Set `NO_COLOR` or `FORCE_COLOR=0` to disable colors.

**Open Console** opens [API keys](https://console.1endpoint.dev/api-keys), or the [Vietnamese API-key page](https://console.1endpoint.dev/vi/api-keys) when Vietnamese is selected. Create a key, copy it, return to the terminal and paste it into the prompt.

### Choose models

For Codex, first choose how Codex should reach 1endpoint:

- **Direct configuration file** writes `~/.codex/config.toml` and a helper-owned model catalog. Codex keeps its own login; no extra software is needed. A Desktop-only installation works: when `codex` is not on `PATH`, the helper uses the CLI bundled inside `ChatGPT.app` (or `Codex.app`), which reads the same file.
- **OpenCodex** writes the 1endpoint provider into an installed [OpenCodex](https://github.com/lidge-jun/opencodex/releases/latest) proxy instead. If `ocx` is not on `PATH`, the helper stops and prints the install command for your operating system.

Either way you then pick one default model, and **every text model from the 1endpoint catalog is added to that route in the same step** — context windows and image support come from the published catalog, so you do not register models one by one.

For DSH, choose the model you want to use by default. Setup targets the **web** profile by default. Scripted setup/reconfiguration can select `--profile web`, `headless`, `acp` or `sdk`; `sdk-minimal` is not supported. Start the same profile you configured.

For OpenClaw and Hermes, choose one default model. OpenClaw setup preserves gateway settings and agent-specific overrides; use its existing gateway lifecycle. Hermes preserves auxiliary-model and fallback-provider settings.

For Claude Code, choose a 1endpoint model for each tier: **Haiku**, **Sonnet** and **Opus**. Each tier can use a different model. Sonnet is the main/default selection and the default subagent model. Select optional **Fable** mapping only if your installed Claude Code version supports it; otherwise keep the standard three-tier option.

If the catalog cannot be loaded, choose **Retry**, explicitly choose **Manual model ID**, or **Cancel**. The helper does not silently substitute a model.

## 2. Restart and use the tool normally

**Close any existing tool session after setup or reconfiguration, then start a new one. An already-open session does not pick up the new connection or model mapping.**

Start Codex by opening Codex Desktop, restarting the IDE extension, or running:

```bash
codex
```

Start DSH:

```bash
dsh web
```

Start Claude Code:

```bash
claude
```

Start Hermes with `hermes`. For OpenClaw, restart your configured gateway using its normal lifecycle, then open `openclaw tui`. The helper does not install, start or alter a background gateway service.

**You do not need the helper to launch the tool.** Setup writes the tool's own native configuration, so normal launches already use 1endpoint. Tool requests may incur charges; normal permission, onboarding and workspace-trust prompts remain active.

### If you chose OpenCodex

Setup finishes by printing the exact next steps, and Doctor repeats them if you lose them:

1. Start the proxy if it is not already running: `ocx start`.
2. Open the dashboard at **http://localhost:10100/**.
3. Restart Codex Desktop, the IDE extension and any terminal session, then run `codex`.

When a proxy is already running, the helper refreshes the Codex model catalog through OpenCodex for you. Otherwise it tells you to run `ocx sync` once after `ocx start`. Codex keeps its own login and settings; OpenCodex only supplies the 1endpoint provider.

### What stays in place

Setup updates the model/provider/authentication values needed for 1endpoint in your actual user configuration. Existing permissions, hooks, unrelated provider configuration, plugins and sessions are preserved. Project and local settings remain active; they are not replaced or isolated away. The selected 1endpoint provider entry and routing/authentication values are managed by setup, with their previous values recorded for removal.

For Codex, setup replaces only the `model`, `model_provider`, `model_catalog_json` and `[model_providers.1endpoint]` values; every other line, comment and table is preserved, and removal restores the previous values and deletes the helper's catalog file. Reasoning-effort keys you set yourself stay untouched, and the generated catalog declares no reasoning levels so Codex does not send an effort the model rejects.

Project/local configuration, inherited environment variables and managed organization policy may take precedence over the selected defaults. Explicit models in agent/skill definitions are not rewritten. Run Doctor if your selection is not taking effect. The helper warns about detectable overrides; it does not edit shell startup files, project settings, managed policy or onboarding state, and does not bypass permissions.

## Native locations and custom paths

| Platform | Codex home | Claude Code user settings | DSH home and default profile |
| --- | --- | --- | --- |
| macOS | `~/.codex` | `~/.claude/settings.json` | `~/.dsh`, profile `web` |
| Linux | `~/.codex` | `~/.claude/settings.json` | `~/.dsh`, profile `web` |
| Windows | `%USERPROFILE%\.codex` | `%USERPROFILE%\.claude\settings.json` | `%USERPROFILE%\.dsh`, profile `web` |

These are path conventions, not a claim that Windows or Linux end-to-end behavior has been tested.

- **Codex:** `CODEX_HOME` selects the Codex home (default `~/.codex`). Direct setup manages the `config.toml` root keys `model`, `model_provider` and `model_catalog_json`, the `[model_providers.1endpoint]` table, and its own `1endpoint-models.json` catalog in the same home. Desktop, the terminal client and the IDE extension read that file, so one setup covers all three. The OpenCodex route writes the `1endpoint` provider into the OpenCodex configuration instead and leaves `config.toml` to OpenCodex's own sync.
- **Claude Code:** `CLAUDE_CONFIG_DIR` selects the configuration directory; setup writes its `settings.json`. Use an absolute path (or the supported `~/` form).
- **DSH:** `DSH_HOME` selects the native home. Setup manages the relevant entries in `profiles/<profile>/cordis.patch.yml` and, when needed, the home `cordis.patch.yml`, plus the API-key entry in `.env`. An existing managed credential reference for that key is reconciled when necessary.
- **OpenClaw:** setup updates `~/.openclaw/openclaw.json`, respecting `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`. It manages the 1endpoint provider, selected model entry and default model/fallback selection. Existing unrelated model entries, tools, channel credentials and gateway settings stay intact. JSON5 is accepted; formatting/comments may be normalized. Configurations using `$include` or external read-only management are refused rather than flattened. Use an explicit state directory for named profiles. If legacy Clawdbot files are detected, set OPENCLAW_CONFIG_PATH explicitly to the active file before setup; the helper does not silently create a competing configuration.
- **Hermes:** setup updates `~/.hermes/config.yaml` (`%LOCALAPPDATA%\hermes\config.yaml` on Windows), respecting `HERMES_HOME`. It manages the named 1endpoint provider and main model connection fields, without changing `.env`, auth pools, auxiliary models, permissions or sessions. YAML formatting/comments may be normalized.
- **Helper state:** defaults to `~/.1endpoint/coding-helper`. Set an absolute `ONEENDPOINT_HELPER_HOME` to relocate it; this does not relocate the native tool homes.

Set custom paths **before setup** and use those same path variables when running the tool, reconfiguring, checking or removing the connection. For example, on macOS/Linux:

```bash
export CODEX_HOME="$HOME/.codex-work"
# Or, for Claude:
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
# Or, for DSH:
export DSH_HOME="$HOME/.dsh-work"
npx @1endpoint/coding-helper
```

On Windows, set the corresponding variables in your shell, using an absolute path under `%USERPROFILE%` or another private directory. Do not change native targets underneath an existing setup; remove the original connection with its original path variables first.

## Check your setup

```bash
npx @1endpoint/coding-helper doctor --tool codex
npx @1endpoint/coding-helper doctor --tool dsh
npx @1endpoint/coding-helper doctor --tool claude
npx @1endpoint/coding-helper doctor --tool openclaw
npx @1endpoint/coding-helper doctor --tool hermes
```

Run the command for your selected tool. Doctor and Remove remain available even after uninstalling the native tool. Doctor checks native setup, whether the executable is installed, key availability and detectable overrides/drift. It does not validate your key against the server or make an inference request. Review its warnings rather than deleting existing configuration blindly.

## Change models or migrate an older setup

Open the helper, select **Reconfigure**, choose the tool, and select new models:

```bash
npx @1endpoint/coding-helper
```

Reconfiguration updates managed native fields while retaining the original pre-setup baseline in a private recovery journal. **Restart the configured tool before using it normally.**

If you used an older helper-only/isolated setup, rerun **Setup** with the same model mapping and choose your saved key, or use **Reconfigure**. This applies the connection to your actual native user configuration; an old helper setup alone does not configure ordinary tool launches.

For scripted use, preview and apply a DSH model change:

```bash
npx @1endpoint/coding-helper reconfigure --tool dsh --model your-model-id --dry-run
npx @1endpoint/coding-helper reconfigure --tool dsh --model your-model-id
```

Replace `your-model-id` with an exact public model ID. To set separate Claude tiers:

```bash
npx @1endpoint/coding-helper reconfigure --tool claude \
  --model your-main-model-id \
  --haiku-model your-fast-model-id \
  --sonnet-model your-balanced-model-id \
  --opus-model your-strong-model-id
```

An optional `--fable-model` sets Fable explicitly. Without it, Fable follows Opus. Explicit tier selections take priority over the `--model` fallback.

## Remove the connection

Stop the tool session first. Open the helper, select **Remove**, choose the tool and review the confirmation. Alternatively:

```bash
npx @1endpoint/coding-helper remove --tool dsh --dry-run
npx @1endpoint/coding-helper remove --tool dsh --yes
```

Use `--tool codex`, `--tool claude`, `--tool openclaw` or `--tool hermes` for the other tools. For Codex, removal also restores or deletes the helper's `1endpoint-models.json` catalog and, on the OpenCodex route, puts the previous OpenCodex `1endpoint` provider entry back. Removal restores only the managed native values to their pre-setup baseline, removing values that did not previously exist. It preserves unrelated edits, permissions, hooks, providers and runtime conversations. **It is not a whole-file reset.** Restart the tool after removal to use the restored settings.

The menu asks whether to **keep or delete the helper's saved API key**. Scripted removal retains it unless you explicitly add `--remove-key`:

```bash
npx @1endpoint/coding-helper remove --tool dsh --yes --remove-key
```

Restoring native authentication settings is separate from keeping the helper's saved key.

### If managed values were edited outside the helper

Setup/reconfiguration and normal removal refuse conflicting changes to managed native values. Review the affected settings and Doctor warnings first. Either reconcile those changes yourself or explicitly choose **Force removal recovery** and review the warning before confirming. For scripted recovery, preview first:

```bash
npx @1endpoint/coding-helper remove --tool dsh --force --dry-run
npx @1endpoint/coding-helper remove --tool dsh --force --yes
```

Force recovery is limited to the managed values and helper-owned connection files. It can replace externally edited managed values with their recorded baseline; it does not reset the entire native file or discard unrelated edits. Use it only after review, then run Setup again if needed. Malformed settings or an invalid recovery journal may require manual repair rather than force.

## Keys and privacy

- Keys are saved automatically on confirmed setup/reconfiguration; there is no storage-choice prompt. Each tool has its own helper key store.
- The helper's saved key, Claude native authentication settings, DSH native `.env`, OpenClaw/Hermes native provider credentials and any managed credential reference are **private plaintext, not encrypted**. Private recovery journals may contain prior credentials and other previous configuration. Protect these locations and any backups you make; do not commit or share them.
- Sensitive files are written with mode **0600** and newly created private directories with **0700** on POSIX systems. Windows permissions depend on your account/filesystem access controls. Other processes running as your user may still access the data.
- The key prompt is masked; do not put keys in command arguments. The helper does not print key values in normal output or logs.
- An explicit helper session key takes priority, followed by `ONEENDPOINT_API_KEY`, then the tool's saved helper key. Inherited native authentication variables may override ordinary tool behavior. If an inherited key conflicts with native DSH setup, reconcile or unset it before applying setup.
- Setup uses `https://1endpoint.dev/api/v1`. The interactive catalog is public and fetched without sending your API key. Explicit setup, reconfigure and doctor commands work locally.
- Native tools retain their normal filesystem/network access. This setup is not an operating-system sandbox.

### Optional: provide a key through your environment

For **Bash**, this hidden prompt keeps the key out of the command itself:

```bash
read -r -s -p "1endpoint API key: " ONEENDPOINT_API_KEY
printf '\n'
export ONEENDPOINT_API_KEY
```

For another shell, use its secure environment-variable mechanism or your secret manager. An environment key is still saved when you confirm setup/reconfiguration so ordinary tool launches can work; supplying it this way is not a no-storage mode. A variable in one terminal is not automatically available after restarting the shell.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Node version error | Install Node.js 22.19 or newer, then reopen your terminal. |
| CLI not found | Install the selected coding tool and put its executable on your `PATH`. |
| API key missing | Open the helper and paste a key, or select Open Console to create one. It is saved on confirmation. |
| Catalog unavailable | Choose Retry, or explicitly enter a known public model ID. |
| New model is not taking effect | Restart the tool; check Doctor for project, environment or managed overrides and check custom path/profile variables. |
| Older setup only works through the helper | Rerun Setup with the same mapping and saved key, or Reconfigure, then restart and launch normally. |
| Managed configuration drift | Review the changes; reconcile them or preview explicit limited force removal before setting up again. |
| Codex shows no 1endpoint models | Run Doctor. A direct setup needs the installed Codex client to read its own catalog template, and the OpenCodex route needs `ocx start` plus `ocx sync` before Codex sees the models. |
| `ocx` not found when choosing OpenCodex | Install OpenCodex (`npm install -g @bitkyc08/opencodex`, or the release for your OS), reopen the terminal and run the helper again. |
| Codex requests fail with `invalid_reasoning_effort` | Your own `config.toml` sets a reasoning effort this model does not support. Remove `model_reasoning_effort` or pick a supported level; the generated catalog declares no reasoning levels. |
| Authentication or model request fails | Confirm key, model access and balance in 1endpoint. Doctor does not validate server-side access. |

This is an independent integration, not an official DeepSeek or Anthropic product.

## More help

- [Console usage guide](https://console.1endpoint.dev/docs/guides/coding-tools/coding-helper)
- [Report a problem](https://github.com/dothinh115/1endpoint-coding-helper/issues)
