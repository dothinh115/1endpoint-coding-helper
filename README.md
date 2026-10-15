# @1endpoint/coding-helper

Connect **DeepSeek Harness** or **Claude Code** to 1endpoint with an interactive setup menu. Choose your language, select models, and manage your connection without editing configuration files by hand.

## Before you start

- Install **Node.js 22.19 or newer**.
- Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) or [Claude Code](https://code.claude.com/docs/en/overview) separately. The helper configures these tools; it does not install them.
- Have a 1endpoint API key ready. Keep it private: do not paste it into command arguments, shared configuration files or a repository.

## 1. Open the helper

Run this in your terminal:

```bash
npx @1endpoint/coding-helper
```

1. Choose **English** or **Tiếng Việt**.
2. Choose **Setup**.
3. Select **DSH** or **Claude Code**.
4. Paste your API key into the masked prompt, or select **Open Console** and press Enter to create a key first.
5. Choose whether to save the key locally or use it for this session only.
6. Select models from the 1endpoint catalog.
7. Review the selection, then choose **Confirm**.

Use **↑ / ↓** to move and **Enter** to select. Press **Escape** to cancel. Confirmation is a selection, not a typed `y/n` answer.

### Choosing models

For DSH, choose the model you want to use by default.

For Claude Code, choose a 1endpoint model for each tier: **Haiku**, **Sonnet** and **Opus**. Each tier can use a different model. Sonnet is used as the main/default selection. Select optional **Fable** mapping only if your installed Claude Code version supports that tier; otherwise keep the standard three-tier option.

If the catalog cannot be loaded, choose **Retry**, explicitly choose **Manual model ID**, or **Cancel**. The helper does not silently substitute a model.

## 2. Provide your API key

Paste your key directly into the helper's **masked API-key prompt**. The key is not shown on screen or placed in command arguments.

Need a key? Select **Open Console** and press **Enter**. The helper opens [API keys](https://console.1endpoint.dev/api-keys), or the [Vietnamese API-key page](https://console.1endpoint.dev/vi/api-keys) when Vietnamese is selected. Create a key, copy it, return to the terminal and paste it into the prompt.

Choose how to use the key:

- **Save locally:** remember it for the selected tool, so future launches do not require manual environment export. The saved file is plaintext, **not encrypted**, protected with private file permissions (0600 file, 0700 directory on POSIX systems). Other processes running as your user may still access it.
- **This session only:** keep it in memory for this helper process. After setup, select **Start a new session now** to launch with it. Reopening the helper later requires entering the key again.
- **Use an existing key:** reuse an available environment or saved key without displaying its value.

DSH and Claude Code store their keys separately. An explicit session key takes priority, followed by `ONEENDPOINT_API_KEY`, then the selected tool's saved key. The helper never puts keys in generated tool settings, model configuration, backups or logs.

### Optional: use an environment variable

If you prefer a secret manager or shell environment instead of local storage, provide `ONEENDPOINT_API_KEY`. For **Bash**, this hidden prompt keeps the key out of the command itself:

```bash
read -r -s -p "1endpoint API key: " ONEENDPOINT_API_KEY
printf '\n'
export ONEENDPOINT_API_KEY
```

For another shell, use its secure environment-variable mechanism or your secret manager. Do not type a real key into a command you intend to share. A key set in one terminal is not automatically available in another terminal or after restarting the shell.

## 3. Check the connection setup

For DSH:

```bash
npx @1endpoint/coding-helper doctor --tool dsh
```

For Claude Code:

```bash
npx @1endpoint/coding-helper doctor --tool claude
```

Doctor checks your saved connection configuration, whether the tool is installed, and whether an environment or saved API key is available. It does not validate the key against the server or make an inference request.

## 4. Start a new tool session

**After setup or reconfiguration, close the old tool session and start a new session through the helper. An already-open session does not pick up the new connection or model mapping.**

Start DSH:

```bash
npx @1endpoint/coding-helper run --tool dsh
```

Start Claude Code:

```bash
npx @1endpoint/coding-helper run --tool claude
```

You can also reopen the helper and select **Run**.

**Use the helper to launch the configured session.** Running `dsh` or `claude` directly uses the tool's ordinary configuration, not this helper connection. Tool requests may incur charges; the tool's normal permission and workspace-trust prompts remain active.

### Important Claude Code behavior

The helper uses an isolated configuration. **Project/local settings, including their hooks and permissions, are not loaded in this mode.** Managed organization policy still applies, and the helper does not enable permission bypass. If your project requires those local restrictions or hooks, use your organization's approved configuration instead.

### Important DSH behavior

DSH runs with a separate home, so your ordinary sessions, plugins and provider settings are not imported or changed. Supported profiles are `web` (default), `headless`, `acp` and `sdk`; `sdk-minimal` is not supported.

## Change models

Open the helper again, select **Reconfigure**, choose the tool, and select new models:

```bash
npx @1endpoint/coding-helper
```

The previous connection configuration is backed up automatically. **Restart the tool session through the helper after confirming the change.**

For scripted use, preview and apply a DSH model change:

```bash
npx @1endpoint/coding-helper reconfigure --tool dsh --model your-model-id --dry-run
npx @1endpoint/coding-helper reconfigure --tool dsh --model your-model-id
```

Replace `your-model-id` with the exact public model ID you want to use. Replace `dsh` with `claude` for Claude Code. To set separate Claude tiers explicitly:

```bash
npx @1endpoint/coding-helper reconfigure --tool claude \
  --model your-main-model-id \
  --haiku-model your-fast-model-id \
  --sonnet-model your-balanced-model-id \
  --opus-model your-strong-model-id
```

An optional `--fable-model` sets Fable explicitly. Without it, Fable follows Opus. Explicit tier selections take priority over the `--model` fallback. Explicit model IDs in your own agent/skill definitions or managed policy are not rewritten by these default mappings.

## Remove the connection

Stop the tool session first. Open the helper, select **Remove**, choose the tool and confirm the removal. You do not need to find or delete configuration files yourself.

Alternatively, preview and confirm removal:

```bash
npx @1endpoint/coding-helper remove --tool dsh --dry-run
npx @1endpoint/coding-helper remove --tool dsh --yes
```

Use `--tool claude` for Claude Code. The menu asks whether to **keep or delete the saved API key**. For scripted removal, add `--remove-key` to delete it explicitly:

```bash
npx @1endpoint/coding-helper remove --tool dsh --yes --remove-key
```

Without that choice, the saved key is retained. Removal deletes only the helper-generated connection configuration and, when selected, its saved key. **Your original tool settings, runtime conversations and configuration backups are preserved.** To return to your ordinary setup, launch `dsh` or `claude` directly.

### Recover from damaged connection configuration

If the helper reports that its generated configuration has been modified or corrupted, choose **Force removal recovery** in the Remove menu, review the warning and confirm. Then run Setup again.

For scripted recovery:

```bash
npx @1endpoint/coding-helper remove --tool dsh --force --yes
```

Force removal deletes only the fixed helper connection files, including modified contents, without backing up those modified contents. It still preserves original tool settings and runtime conversations. Use it only for recovery, not routine reconfiguration.

## Configuration and privacy

- The shared API base URL is `https://1endpoint.dev/api/v1`.
- Connection configuration is stored under `~/.1endpoint/coding-helper`. Set an absolute `ONEENDPOINT_HELPER_HOME` if you need a different location.
- Setup does not overwrite your existing DSH or Claude Code configuration.
- The interactive menu fetches the public text-model catalog without sending your API key. Explicit setup, reconfigure and doctor commands work locally.
- Your key is supplied to the launched tool through its process environment, not saved in the helper's connection files.
- Runtime tools can create their own session data. Keep their isolated homes private.
- Configuration isolation is **not an operating-system sandbox**; the tools retain their ordinary filesystem and network access.

This is an independent integration, not an official DeepSeek or Anthropic product.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Node version error | Install Node.js 22.19 or newer, then reopen your terminal. |
| CLI not found | Install the selected coding tool and make sure its executable is on your `PATH`. |
| API key missing | Open the helper and paste a key, or press Enter on Open Console to create one. Choose Save locally for future launches. |
| Catalog unavailable | Choose Retry, or explicitly choose manual entry with a known public model ID. |
| New model is not taking effect | Close the old session and start a new one with the helper's Run action. |
| Ordinary tool launch ignores the helper | Launch through `npx @1endpoint/coding-helper run --tool dsh` or `--tool claude`. |
| Generated configuration is damaged | Use Remove → Force removal recovery, then Setup again. |
| Authentication or model request fails | Confirm your key, model access and account balance in 1endpoint. Doctor does not validate server-side access. |

## More help

- [Console usage guide](https://console.1endpoint.dev/docs/guides/coding-tools/coding-helper)
- [Report a problem](https://github.com/dothinh115/1endpoint-coding-helper/issues)
- Maintainers: [publishing](docs/PUBLISHING.md) and [release verification](docs/RELEASE.md).
