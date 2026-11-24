# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

This fork targets DSH `0.2.2-rc.5`. Use a dedicated profile and choose the local-only, single-operator GitHub, or shared-repository flow in [SETUP.md](SETUP.md). The local CLI can submit to a Desk, pause and resume dispatch, stop the service, and make a consistent SQLite backup.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## Community ports

- DSH 0.2.2 API adaptation, all-provider model picker, and archived-router recovery by huangchenbj. Sources: `51bbab8115e7dea6709d8a03ca0f3ac8e9c89409`, `06ef0620ddd35dccecbf054d6a8df18e34e9c97c`, and `5cb4a44d892170aa6dddb38edeb261393a59e046`.
- Optional GitHub deployment adapted from Connor Qiao's `a11ccc2537a1c4f8e49c3d5359f2e7cd76411cbf`.

The ports retain the source projects' MIT license terms.

## License

[MIT](LICENSE)
