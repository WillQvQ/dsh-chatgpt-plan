# DeepSeek Harness · Sign in with ChatGPT

[简体中文](README.md) | **English**

<img src="assets/icon.webp" alt="DeepSeek girl eating ChatGPT Tokens" width="160" />

Use your own ChatGPT plan in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Install the plugin, sign in independently with **Continue with ChatGPT**, authorize plan usage, and choose an available model in DSH.

This is an unofficial local plugin with MIT-licensed source code. Each user authorizes their own account; the package contains no accounts, credentials, or shared allowance. It follows [OpenAI's open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). No API key is required, and it does not read Codex or Pi login files.

## Requirements

| Component | Version / requirement |
| --- | --- |
| Plugin | **0.1.1** |
| DeepSeek Harness | **0.2.0-rc.2** |
| pi-ai used by DSH | **0.87.1**, supplied by the host |
| Verified desktop platform | macOS; other platforms have not been verified |
| ChatGPT account | Eligible for OpenAI's current plan integration, with permission granted to use the plan |

Models and limits depend on what OpenAI returns for your account. “ChatGPT Pro Plan” on the icon is illustration text: it does not mean the plugin is Pro-only or includes unlimited usage. Recheck compatibility after upgrading DSH.

For details on the host's pi-ai dependency, the implementations this plugin reuses, and version compatibility, see [Relationship with DSH and pi-ai](#relationship-with-dsh-and-pi-ai) below.

## Install

Download **`dsh-chatgpt-plan-0.1.1.tgz`** from the [v0.1.1 release](https://github.com/WillQvQ/dsh-chatgpt-plan/releases/tag/v0.1.1). Use this plugin package; GitHub's automatically generated Source code archives are for browsing the source.

Quit DSH completely. On macOS, run this in Terminal, assuming the file is in Downloads and the App is in `/Applications`:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "$HOME/Downloads/dsh-chatgpt-plan-0.1.1.tgz"
```

DSH resolves runtime dependencies, including `undici`, during installation, so access to the package registry is required. Do not replace individual source files. Reopen DSH and confirm `dsh-chatgpt-plan` is enabled in the plugin list.

Adjust the App path if needed. For another DSH profile, replace `desktop` with its name; each profile requires separate installation and authorization.

## Sign in and start using a model

1. Open DSH **Settings → ChatGPT 套餐 (ChatGPT plan) → Continue with ChatGPT**.
2. Click **Continue with ChatGPT** on the local account page to open OpenAI's authorization page.
3. Confirm the account and app name **DeepSeek Harness**, then grant plan usage if desired. Identity-only sign-in does not enable inference.
4. Return to DSH and select a model under **ChatGPT 套餐（独立授权）** (“ChatGPT plan — independent authorization”).
5. Send a message. DSH continues to manage history, local tools, file permissions, and streaming display.

Always open the account page from DSH Settings. It listens on loopback only, prefers port `18762`, and chooses another available port if necessary. A fixed URL is not a shared management endpoint for all instances. The plugin UI currently uses Chinese labels; this README provides their English meanings.

## Add and switch accounts

1. Click **添加账号 · Continue with ChatGPT** (“Add account”). Confirm or switch accounts on OpenAI's page.
2. Authorize each account separately. Use **修改备注** (“Edit label”) for names such as “Personal Pro” or “Work”.
3. Click **切换到此账号** (“Switch to this account”), then select a model available to that account in DSH.

Switching cancels the previous account's in-progress requests and refreshes the model list. Registrations keep separate credentials and models, even when email addresses match. Only one account is active at a time. The plugin does not automatically rotate accounts, pool allowances, or fall back to another account after an error or sign-out.

Switching does not clear DSH conversation history. Start a new conversation to separate chat content.

## Network settings

Under **网络连接** (“Network connection”) on the account page, choose:

| Mode | Behavior |
| --- | --- |
| 使用环境代理设置 — Environment proxy | Reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`, including lowercase variants; does not automatically read macOS system proxy settings |
| 直接连接 — Direct | Connects without a proxy |
| 指定 HTTP(S) 代理 — Custom proxy | Accepts a URL such as `http://127.0.0.1:7890`; SOCKS, credentials, paths, and query parameters are unsupported |

Saving settings cancels current plugin requests. These settings affect this plugin only; browser authorization uses the browser's own network configuration. Apps launched from Finder may not inherit Terminal proxy variables, so configure a custom HTTP(S) proxy when needed.

## Usage, renewal, and sign-out

Click **管理 ChatGPT 用量与额度** (“Manage ChatGPT usage and limits”) or open [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). The plugin has no total remaining allowance dashboard; OpenAI manages usage and access limits.

Credentials are renewed when needed, respecting the earliest refresh time returned by the service. Temporary network errors preserve an otherwise valid login; expired credentials are not used. An inference HTTP 401 can trigger one refresh and retry. A response stream that has already started is not replayed.

Signing out attempts to revoke the registration's renewable session, then removes local tokens. If remote revocation cannot be confirmed, the page tells you. To disconnect completely, go to **ChatGPT Settings → Security & login → Sign in with ChatGPT → DeepSeek Harness → Disconnect**. See [OpenAI's accounts and sessions documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No plugin settings | Confirm installation in the active DSH profile and that the plugin is enabled, then quit and reopen DSH |
| Signed in, but no models | Confirm plan permission, refresh models, and check eligibility and network settings |
| Browser sign-in works, but the plugin cannot connect | Check browser and plugin network settings separately |
| Model unavailable after switching accounts | Select a model actually returned for the new account |
| Authorization expired | Sign in again; do not copy another app's token files |
| Credential permission error | Check current-user ownership, owner-only permissions, and that the file is not a symlink; never attach account files to an issue |
| Resuming a goal reports `objective and max_goal_rounds are valid only with action edit` | Upgrade to **0.1.1** and restart DSH; see below |
| `stale goal ref` or `the model cannot resume a paused goal` | Check the goal revision and paused state as described below |

### Goal recovery and tool argument errors

**0.1.1 fixes optional tool parameters being forced into calls.** In 0.1.0, the plugin configuration made pi-ai omit `strict` from tool definitions. The Responses API may then normalize optional parameters into required ones. For example, an `update_goal` call with `action: "resume"` could include the edit-only `max_goal_rounds` field and be rejected by DSH. Version 0.1.1 makes pi-ai explicitly send `strict: false`, preserving optional parameters. See [OpenAI's strict-mode documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

Goal recovery also follows DSH's own state and permission rules:

- **`stale goal ref`**: the goal has changed, but the model is using an old `revision`. Read the current state with `get_goal` before deciding what to do next; do not retry the old revision. Operations such as pausing and resuming advance the revision. This error alone does not indicate expired credentials or corrupted data.
- **`the model cannot resume a paused goal`**: the user must click Resume in the goal interface or send **`/goal resume` by itself** in the original conversation. An ordinary chat message such as “continue” does not replace this command.
- **An `active` goal does not continue automatically after a restart**: it may be `disarmed`; use `/goal resume` to re-enable continuation. `max_goal_rounds` limits automatic continuation rounds, each of which can contain multiple tool calls.

These rules come from the [goal tools](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/goal/tool-goal/README.md) and [user commands](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/goal/command-goal/README.md) in the verified DSH 0.2.0-rc.2 source. The plugin preserves these state and permission checks.

## Data and authorization

Account data is stored in `data/dsh-chatgpt-plan/accounts.json` under the active DSH profile, with `network.json` beside it. On macOS, the desktop profile typically uses `~/.dsh/profiles/desktop/data/dsh-chatgpt-plan/`. Directory permissions are `0700`; file permissions are `0600`.

Credentials are in a local file, **not an encrypted vault**. Programs running as the same system user or with sufficient privileges may read them. Do not share account files, full authorization callback URLs, tokens, or logs containing them. Published source and packages contain no runtime account data.

The implementation uses dynamic registration, Authorization Code + PKCE, per-attempt state and nonce, and ID-token signature, issuer, audience, expiration, and identity checks. Credentials are written atomically, and refreshes are serialized with a file lock. The local management page checks Host, Origin, and CSRF; OAuth tokens are not sent to its frontend.

Models come from `https://api.openai.com/v1/models`; inference uses `https://api.openai.com/v1/responses` with `store:false` and `stream:true`. The plugin adapts local tool calls, does not use ChatGPT `backend-api`, and does not fall back to API-key billing. Other search or external services retain their existing DSH configuration. See [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Upgrade and uninstall

Quit DSH before installing a newer `.tgz` with the same installation command. Normal upgrades preserve account files within the same DSH profile. Reopen DSH and check the connection afterward.

Before uninstalling, sign out on the account page and select another provider as DSH's default model. Quit DSH, then run:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-chatgpt-plan
```

Uninstalling does not itself disconnect the app at OpenAI. Follow the sign-out instructions above to revoke access completely.

## Relationship with DSH and pi-ai

**You do not need to install the Pi app separately.** This plugin reuses `@deepseek-ai/dsh-llm-pi-ai` and `@earendil-works/pi-ai` supplied by the DSH host. The verified combination is DSH **0.2.0-rc.2** with pi-ai **0.87.1**; these versions are also declared in this project's [peerDependencies](package.json).

### Where DSH depends on pi-ai

In the DSH 0.2.0-rc.2 source reviewed here, direct use of pi-ai is concentrated in the [`@deepseek-ai/dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-pi-ai/src) model adapter:

- **Provider and model catalogs, and authentication interfaces:** connects pi-ai's provider definitions, model capabilities, and authentication flows to DSH's configuration and credential management.
- **Request protocols and streaming:** uses pi-ai implementations such as OpenAI Responses, Chat Completions, and Anthropic Messages to send requests and process response events.
- **Conversion between DSH and pi-ai:** DSH's adapter code translates message context, tool definitions, stream events, usage, and replay metadata for DSH's model interface.

DSH continues to provide the agent loop, tool execution, file permissions, conversation storage, plugin system, and interface. Its [native DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-deepseek) also has a separate implementation; the dependency described above is concentrated in model integration.

### What this plugin reuses

This plugin registers only the ChatGPT plan provider. DSH's overall use of pi-ai is broader than the parts this plugin calls directly.

| Implementation source | Role in this plugin |
| --- | --- |
| DSH's bundled `PiAiAdapter` | Connects the plugin's models and responses to DSH's model interface, reusing message, tool, and stream-event conversion |
| DSH's bundled `pi-ai/api/openai-responses` | Builds Responses requests and parses streamed responses through `stream` / `streamSimple` |
| This plugin | Independent ChatGPT authorization, account management, credential renewal, discovery of models available to the account, and adaptation of plan request parameters and local tool calls |

See [index.mjs](index.mjs) for imports and adapter registration, and [adapter.mjs](adapter.mjs) for request adaptation. The plugin implements ChatGPT sign-in in [oauth.mjs](oauth.mjs); it does not read Pi or Codex login files.

### How this relates to newer pi-ai versions

For comparison, [pi-ai 1.0.2 already includes a Sign in with ChatGPT implementation](https://github.com/earendil-works/pi/blob/v1.0.2/packages/ai/src/auth/oauth/openai-chatgpt.ts). This project targets the DSH / pi-ai combination verified here and packages ChatGPT plan access as a separately installable DSH plugin with an account-management interface.

That upstream capability does not establish that an older DSH release includes it, or that replacing the host's pi-ai with 1.x will remain compatible. Updating pi-ai elsewhere on the system or in another project does not update the dependency bundled in DSH. After upgrading DSH or changing dependencies, recheck plugin loading, authorization, model discovery, streaming replies, and tool calls.

See the [DSH community discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/8851) for discussion of extension interfaces suitable for long-term maintenance.

## Build from source and develop

Use Node.js 22 or later; this release was validated with Node.js 24. There is no compilation step:

```sh
git clone https://github.com/WillQvQ/dsh-chatgpt-plan.git
cd dsh-chatgpt-plan
npm test
npm pack --ignore-scripts
```

`npm test` uses Node's built-in runner and mocked responses. It needs no real account, internet connection, or installed DSH host dependencies. `npm pack` creates `dsh-chatgpt-plan-0.1.1.tgz`; install it as described above. DSH resolves dependencies for actual runtime use during installation.

Tests cover account isolation, PKCE and identity validation, cancellation on switching, renewal and backoff, 401 retry, revocation, storage permissions, profile isolation, port conflicts, network settings, and management-page access control. On macOS with the compatible DSH version installed, also run the native adapter simulation:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/wire-test.mjs
```

This test also mocks the network. It checks that requests emitted through DSH and pi-ai explicitly include `strict: false` and retain optional tool parameters, including after account switching and a 401 refresh retry. Passing simulations does not establish eligibility for every real account; actual use requires the account owner's authorization.

## License and artwork

Code is licensed under the [MIT License](LICENSE). The unofficial icon includes an AI-generated DeepSeek girl and ChatGPT Token illustration. It does not imply publication, certification, or endorsement by DeepSeek or OpenAI. The code license does not grant rights to third-party brands or underlying character designs.
