# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## Choose a deployment

1. **Local only.** Leave the GitHub repository and CLI empty. Generate an operator token, install the bundle in a dedicated DSH `0.2.2-rc.5` Web profile, and use the Local Source CLI to submit a ticket. A configured DSH model is needed for Workers to run. An idle server and queued local tickets require no GitHub login.
2. **Single-operator GitHub repository.** Configure `owner/repository` and the path to an authenticated `gh` executable. Setup checks its identity and repository push access. This grants the Worker the rights of the account behind that executable. Use a restricted account if that scope is wider than the intended workload. GitHub notifications from the same account do not serve as a self-assignment channel. Use the Local Source to start tasks yourself.
3. **Shared repository.** Configure a separate GitHub user and CLI profile as described by the team setup below. Give that identity access only to the repository it watches. Configure the Source allowlist and the repository's own branch protection.

Run `scripts/dsh-superagent init-token --output <private-file>` in an operator terminal, and put the printed SHA-256 value in the plugin's `operatorTokenHash` setting. The token itself stays outside the DSH profile, state directory and workspaces. The desktop panel accepts an authenticated DSH session and offers inline token entry when needed. Execution uses `danger-full-access` by default for unattended Git worktrees and automation; the operator can switch to `workspace-write` in **Settings → Execution**. Read the [deployment guide](docs/006-deployment.md) for workspaces, local submission, and backup.

## Desktop setup

Enable the Superagent bundle in the DSH 0.2.2-rc.5 Desktop Profile. Open the repository Workspace menu and choose **Register with Superagent**, then check its directory, project ID, worktree root and desks in the form. Repeat for each repository you want to use. The Workspace menu opens its Router, board or Ticket composer. Router and Worker rows show their state and provide direct links to the corresponding board or Ticket.

Run `sa submit --project <id> --desk <desk> --title "Review the change" --file request.md`, or leave out `--project` when running from a registered Git checkout. See [Deployment](docs/006-deployment.md) for CLI endpoint discovery and [Panel](docs/005-panel.md) for the sidebar and Router behavior.

## Guided shared-repository setup

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, GitHub CLI 2.48+, and DSH within the `engines.dsh` range of `package.json`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** the `gh api user` result is the operator's own GitHub login, used as the recommendation in question 5.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Sources.** Should the agent take requests from GitHub only, or also from Feishu chats? [GitHub only, unless the team works in Feishu.]
2. **Repository.** Which github.com repository should the agent work on, as `owner/name`?
3. **Agent account.** Which GitHub user account will the agent act as? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step.
4. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.

**Policy: who may ask for work.**

5. **On GitHub.** Which GitHub logins may ask the agent for work? [Only `<operator login>`: the agent acts only for people on this list, and a short list keeps the team's noise low while the operator learns how the agent behaves.]
6. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

7. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
9. **Auto-merge.** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements.

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; an available loopback port; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs dsh-superagent when it is not running;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrappers yourself, then send one message with what only the operator can do: create the agent account and, with auto-merge, sign a CLI in as the account that enables it, accept the repository invitation as the agent account, run `auth login` for each wrapper, and for Feishu create and publish the bot app and run the `config init` command with its secret. Wait until the operator says it is done, then check each login with `<wrapper> api user --jq .login`.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. Clone the repository of question 2 if question 7 asked for a new clone. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the `github` Source, the `feishu` Source if used, the `policy` block with the allowed lists (for Feishu, look up the chat ids with the bot's CLI first), and the `executor` block with a prepare command from the answer to question 7. Then save the prompts with the commit identity of question 8 and the auto-merge answer of question 9 in Delivery requirements. A save that returns `restarting: true` restarts dsh-superagent: wait until `scripts/dsh-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/dsh-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository. A Ticket appears on the overview within about a minute.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
