# DeepSeek Harness · Sign in with ChatGPT

[简体中文](README.md) | **English**

<img src="assets/icon.webp" alt="DeepSeek girl eating ChatGPT Tokens" width="160" />

Use your own ChatGPT plan in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Install the plugin, sign in independently with **Continue with ChatGPT**, authorize plan usage, and choose an available model in DSH.

This is an unofficial local plugin with MIT-licensed source code. Each user authorizes their own account; the package contains no accounts, credentials, or shared allowance. It follows [OpenAI's open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). No API key is required, and it does not read Codex or Pi login files.

## Requirements

| Component | Version / requirement |
| --- | --- |
| Plugin | **0.1.0** |
| DeepSeek Harness | **0.2.0-rc.2** |
| pi-ai used by DSH | **0.87.1**, supplied by the host |
| Verified desktop platform | macOS; other platforms have not been verified |
| ChatGPT account | Eligible for OpenAI's current plan integration, with permission granted to use the plan |

Models and limits depend on what OpenAI returns for your account. “ChatGPT Pro Plan” on the icon is illustration text: it does not mean the plugin is Pro-only or includes unlimited usage. Recheck compatibility after upgrading DSH.

## Install

Download **`dsh-chatgpt-plan-0.1.0.tgz`** from the [v0.1.0 release](https://github.com/WillQvQ/dsh-chatgpt-plan/releases/tag/v0.1.0). Use this plugin package; GitHub's automatically generated Source code archives are for browsing the source.

Quit DSH completely. On macOS, run this in Terminal, assuming the file is in Downloads and the App is in `/Applications`:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "$HOME/Downloads/dsh-chatgpt-plan-0.1.0.tgz"
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

## Build from source and develop

Use Node.js 22 or later; this release was validated with Node.js 24. There is no compilation step:

```sh
git clone https://github.com/WillQvQ/dsh-chatgpt-plan.git
cd dsh-chatgpt-plan
npm test
npm pack --ignore-scripts
```

`npm test` uses Node's built-in runner and mocked responses. It needs no real account, internet connection, or installed DSH host dependencies. `npm pack` creates `dsh-chatgpt-plan-0.1.0.tgz`; install it as described above. DSH resolves dependencies for actual runtime use during installation.

Tests cover account isolation, PKCE and identity validation, cancellation on switching, renewal and backoff, 401 retry, revocation, storage permissions, profile isolation, port conflicts, network settings, and management-page access control. On macOS with the compatible DSH version installed, also run the native adapter simulation:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/wire-test.mjs
```

This test also mocks the network. Passing simulations does not establish eligibility for every real account; actual use requires the account owner's authorization.

## License and artwork

Code is licensed under the [MIT License](LICENSE). The unofficial icon includes an AI-generated DeepSeek girl and ChatGPT Token illustration. It does not imply publication, certification, or endorsement by DeepSeek or OpenAI. The code license does not grant rights to third-party brands or underlying character designs.
