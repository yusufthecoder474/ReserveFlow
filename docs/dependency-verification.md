# Dependency verification record — 2026-10-10

This is a pre-install review, not a successful dependency installation or software composition analysis.

## Reviewed against current official pages

| Component | Intended pin/range | What was verified | Source |
|---|---|---|---|
| Node.js | 24.21.0 via `.nvmrc` | Official release table identifies the 24.x line as LTS; the local environment is Node 22.16.0 and does not match `.nvmrc`. | https://nodejs.org/en/about/previous-releases |
| Express | 5.3.0 | Official Express release/history records the 5.3.0 release and security-related dependency fixes. | https://github.com/expressjs/express/blob/master/History.md |
| TypeScript | 6.0.2 | npm package metadata reports 6.0.2; typescript-eslint's documented support is `>=4.8.4 <6.1.0`. | https://www.npmjs.com/package/typescript, https://typescript-eslint.io/users/dependency-versions/ |
| PostgreSQL | 18.6 | Official support/versioning page lists 18.6 as the current minor for the supported 18.x series. | https://www.postgresql.org/support/versioning/ |
| React | 19.3.0 | Official React version page identifies 19.3 as the latest documented version and lists its September 2026 release. | https://react.dev/versions |
| `pg`, Vite, Vitest, Zod, Pino, React type packages, `tsx`, `dotenv`, other type packages | Exact pins are in the workspace manifests | These are provisional pins carried from the project plan. Their npm registry metadata and peer-dependency compatibility still need a successful clean installation. | https://node-postgres.com/, https://vite.dev/releases, https://vitest.dev/guide/, https://zod.dev/ |

## Install attempt and unresolved checks

An `npm install --ignore-scripts --no-audit --no-fund` attempt timed out in the current environment. No dependency lockfile was generated. Docker is also unavailable in the current environment, so PostgreSQL startup was not exercised.

Before merging Milestone 1 into a normal development environment:

1. Use Node.js 24.21.0.
2. Run `npm install` with registry access and inspect warnings or peer conflicts.
3. Commit the generated `package-lock.json` only after a successful resolution.
4. Run `npm run typecheck`, `npm run build`, and `npm test`.
5. Start PostgreSQL with Docker Compose and verify `/api/health/ready` returns 200; stop PostgreSQL and verify it returns 503 without leaking database details.
6. Inspect dependency advisories and update any affected pins before adding business workflows.

Do not describe the dependency tree as verified, vulnerability-free, or reproducible until these checks pass.
