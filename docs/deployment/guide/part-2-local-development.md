# Part 2. Local development and testing

**Status:** written. Way A was tested end to end on 2026-10-18 on a clean Linux machine (4 processor cores, 15 GB of memory) with commit `160b18a`. Way B couldn't be built on that machine, because its network blocked the image builds, so its steps come from the docs and the code and are marked untested. Since then, Way B has run once, on Windows 11 on 2026-10-26 ([2.5](#25-way-b-run-everything-in-docker)). [2.2](#22-install-the-tools)'s pnpm moved to 12.15.0 on 2026-10-28 for fork PR #91: on Linux, `pnpm install`, the build and the tests ran with it, but not yet on Windows or a Mac.

This part puts a complete LobbyStack on your own computer. It's the safest place to learn how LobbyStack works and to try changes, because nothing you do here reaches real customers. There are two ways to run it:

- **Way A** runs the apps straight from the code, with only the database and Redis in Docker. Use it to try LobbyStack and to change code. Start here.
- **Way B** runs everything in Docker, the way a server does. Use it to check a change before it goes to a server.

## 2.1 What works on your computer

| Feature | Works on your computer? |
| --- | --- |
| Dashboard, sign-up, sign-in, onboarding, settings, knowledge you type in | Yes, with no outside accounts |
| Website chat and browser test calls | Yes, with an OpenAI API key ([2.3](#23-get-the-code-and-create-your-settings-file)) |
| Emails, such as sign-up codes and invites | Yes, with Mailpit, an email catcher ([2.7](#27-optional-extras)) |
| Phone calls and texts | Only through a public tunnel with a test number ([2.7](#27-optional-extras)) |
| Buying phone numbers | No: it needs the Twilio SIP trunk ([Part 3](part-3-outside-services.md)) |
| Website import | Yes, with a Firecrawl key |
| Google Calendar | Yes, with a Google OAuth client ([Part 3](part-3-outside-services.md)) |

A feature whose account isn't set up fails when you use it. The README mentions "mock providers" that stand in for these accounts, but they exist only in the automated tests.

## 2.2 Install the tools

You need a computer running Windows 10 or 11, macOS, or Linux, with at least 5 GB of free disk space: the code's packages take about 2.3 GB and the Docker images about 1 GB.

Install these programs:

| Program | Version | Where to get it |
| --- | --- | --- |
| Git | Any recent version | git-scm.com. On a Mac, typing `git --version` in Terminal offers to install it. |
| Docker | Docker Desktop on Windows and Mac; on Windows, keep the WSL 2 option it suggests. On Linux, Docker Engine 24 or later with the Compose plugin. | docker.com |
| Node.js | 26 | nodejs.org, the installer for your system |
| pnpm | 12.15.0 exactly | The command below |

Open a terminal (PowerShell on Windows, Terminal on a Mac) and install pnpm:

```sh
npm install --global pnpm@12.15.0
```

Node 26 doesn't come with Corepack, so `npm` is the way to install pnpm, and the same command replaces an older pnpm. npm may warn that pnpm's install scripts aren't covered by `allowScripts`; it runs them anyway.

Check that each tool works. Each command prints a version:

```sh
git --version
docker compose version
node --version
pnpm --version
```

`node --version` should start with `v26`, and `pnpm --version` should print `12.15.0`. Start Docker Desktop before you go on, and leave it running.

LobbyStack uses these ports on your computer, so close anything else that uses them: 13000 (dashboard), 13002 (worker), 4321 (marketing site), 15433 (PostgreSQL) and 16380 (Redis).

## 2.3 Get the code and create your settings file

The fork is public, so you can download it without a GitHub account. If you made your own fork ([1.4](part-1-prepare.md#14-get-the-code)), put its owner's name in place of `devresponse` in the commands below, because releases push from this copy ([7.1](part-7-operations.md#71-release-a-new-version)).

```sh
git clone https://github.com/devresponse/lobbystack.git
cd lobbystack
```

The same two commands work on Windows. Git for Windows normally gives files Windows line endings, which break the database setup script, but the code's `.gitattributes` file tells Git to keep Linux line endings on every computer, so there's nothing to set. (Tested with Git set up the way Git for Windows sets it up, on Linux; not yet on a Windows machine.) If you cloned on Windows before fork PR #83, follow "Line endings on Windows" in `docs/voice/local-debugging.md`.

Then download the code's packages and create your settings file:

```sh
pnpm install
pnpm env:generate
```

- `pnpm install` takes about half a minute. A warning about "Ignored build scripts" is harmless.
- `pnpm env:generate` writes a file named `.env` with new random passwords and secrets, and prints `Wrote .env with 15 generated secrets.`
- `.env` holds secrets. Never share it, paste it into a chat, or add it to Git. Git already ignores it.

For website chat and browser test calls, create a second settings file named `.env.local` in the same folder, with your OpenAI key on one line:

```dotenv
OPENAI_API_KEY=your_openai_api_key
```

`.env.local` is for your own keys and changes. LobbyStack reads it before `.env`, so its values win, and Git ignores it too.

## 2.4 Way A: run from source

Run these commands one at a time, from the `lobbystack` folder:

```sh
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @lobbystack/telemetry build
pnpm --filter @lobbystack/shared build
pnpm dev
```

1. `docker compose up -d postgres redis` downloads and starts the database (PostgreSQL) and Redis in Docker. It takes about 10 seconds the first time.
2. `pnpm db:migrate` creates the database tables, in about 10 seconds. It ends with `Database migrations applied.`
3. The two `build` commands prepare two internal packages that the dashboard loads ready-made, in a few seconds. Without them the dashboard won't start, or, on a copy older than `7893d2e`, onboarding stops at the plan step ([2.10](#210-if-something-fails-locally)). Run them again after you download new code.
4. `pnpm dev` starts the dashboard, the worker and the marketing site, and keeps running. Leave this terminal window open.

About 15 seconds later, check that it's up by opening these addresses in your browser:

- `http://localhost:13000/api/health/ready` shows `"ok":true`, with `"database":"ok"`, `"storage":"ok"` and `"redis":"ok"`.
- `http://localhost:13002/health/ready` shows `"ok":true` and `"ready":true`.

The first page you open takes about 10 seconds more, while the dashboard prepares it.

To stop, press Ctrl+C in the terminal running `pnpm dev`. The marketing site can keep running in the background after that; stop it with `pnpm --filter @lobbystack/landing exec astro dev stop`.

## 2.5 Way B: run everything in Docker

**Run once,** on Windows 11 on 2026-10-26 with `c074ae4`: the images built and every service became healthy. That clone was made before fork PR #83, so its files first needed Linux line endings, and IIS held port 80, so Caddy needed `HTTP_PORT` ([2.10](#210-if-something-fails-locally)). The steps come from `docs/voice/local-debugging.md` and `docker-compose.yml`.

1. Stop Way A first with Ctrl+C, because Way B uses the same ports.
2. Build and start everything:

   ```sh
   docker compose --env-file .env --env-file .env.local up -d --build
   ```

   Leave out `--env-file .env.local` if you didn't create that file. The first run takes several minutes, because it builds the dashboard, worker and migration images from the code.
3. `docker compose ps` lists the services. The migrator runs once and stops; the others stay up.
4. Check the same two health addresses as in Way A: `http://localhost:13000/api/health/ready` and `http://localhost:13002/health/ready`.
5. Open the dashboard at `http://localhost:13000`, not at `http://localhost`. Caddy answers at `http://localhost` too, but sign-in refuses that address, because it isn't `APP_BASE_URL`.
6. Read the logs with `docker compose logs -f admin worker`. On a copy older than `7893d2e`, don't share PostgreSQL's first-start log: it shows the database passwords.

After you change code, run the same `up -d --build` command again to rebuild.

Two things to know about Way B:

- Businesses created in Way B get the unlimited `self_host` plan, because Compose passes `DEPLOYMENT_MODE` to the services since fork PR #47 (`7893d2e`). On an older copy, they become cloud businesses on the free plan, with 30 browser minutes and no phone number ([8.12](part-8-troubleshooting.md#812-a-business-on-the-free-plan-by-mistake)).
- The dashboard and worker run in production mode here, so they refuse placeholder secrets, such as those in a copy of `.env.example`. `pnpm env:generate` ([2.3](#23-get-the-code-and-create-your-settings-file)) avoids this.

## 2.6 Sign in for the first time and create a test business

1. Open `http://localhost:13000`, typed exactly like that. With `127.0.0.1` instead of `localhost`, sign-in says "Incorrect email or password" even when the password is right.
2. Sign up at `http://localhost:13000/en/signup`. The password needs at least 8 characters, a number and a special character. No captcha appears on your computer.
3. The next page asks for a 6-digit code sent by email. Without an email setup it never arrives. Go to `http://localhost:13000/en/login` instead, and sign in with the same email and password. This works because your settings don't require a verified email.
4. Onboarding walks you through these steps:
   1. Your business's name. The app is already AlloPlace, the only brand in the code besides LobbyStack, so nothing asks you to name it. A copy older than fork PR #87, or one with no brand of its own, first shows **Make this app your own** ([6.2](part-6-first-run.md#62-the-brand-step)).
   2. Your website, or **I don't have a website**. Importing a website needs a Firecrawl key.
   3. Knowledge: **Skip for now**.
   4. The greeting callers hear.
   5. The plan: choose **Start free**. The page lists the plans of AlloPlace's `brands/alloplace/billing.json`, in Canadian dollars, with **Starter** and **Pro** greyed out, since nothing sells them on your computer (fork PR #88). On your own instance a business has unlimited call minutes anyway.
   6. How you heard about AlloPlace: **Skip**.
5. The dashboard opens with your business.
6. Add at least one service and your opening hours. The receptionist can't book anything until the business has an active service.
7. With your OpenAI key in `.env.local`, restart `pnpm dev` and use the dashboard's **Test Call** button to talk to your receptionist from the browser. (Not tested yet: the test machine had no OpenAI key.)

## 2.7 Optional extras

- **Read the emails LobbyStack sends.** Mailpit catches them so you can read them in your browser. Start it with `docker compose --profile development up -d mailpit`, add `SMTP_HOST=127.0.0.1` and `SMTP_PORT=1025` to `.env.local`, restart `pnpm dev`, and open `http://localhost:8025`. (Not tested yet: Docker Hub refused the Mailpit download with "429 Too Many Requests". Signing in to Docker with `docker login` raises that limit.)
- **Try S3-style file storage** with MinIO: see "Choose a storage backend" in `mintlify/self-hosting/docker-compose.mdx`.
- **Take real phone calls and texts** on your computer through a public tunnel and a test number: follow "Take real phone calls and texts" in `docs/voice/local-debugging.md`.
- **Step through the code in VS Code:** follow "Debug in VS Code" in the same file.
- **Demo data:** `pnpm db:seed` adds a Demo Business. Nobody owns it, so you can't sign in to it.

## 2.8 Run the checks before you ship a change

Run these from the `lobbystack` folder before you open a pull request. Each must finish without errors:

```sh
pnpm typecheck
pnpm test
pnpm build
```

- `pnpm build` takes a few minutes. On the test machine the dashboard's part alone took about 2.5 minutes.
- If you changed the database (migrations or access rules), also run `pnpm db:check` and `pnpm db:verify-rls` against a test database.
- If you changed how calls behave (the call instructions, the call controller, or how calls end), run `pnpm voice:eval` before you open the pull request, and `pnpm voice:call` against the test environment before you merge. See `docs/voice/testing.md`.
- The fork's GitHub checks run the full suite on every pull request, in about 10 minutes.

## 2.9 Stop, reset and update

| To | Do this |
| --- | --- |
| Stop the apps | Press Ctrl+C in the `pnpm dev` window |
| Stop the database and Redis, keeping the data | `docker compose stop` |
| Start them again | `docker compose up -d postgres redis` |
| Delete all local data and start over | `docker compose down -v`, then continue from step 1 of Way A |
| Get the newest code | `git pull`, `pnpm install`, `pnpm db:migrate`, the two `build` commands, then `pnpm dev` |

`pnpm env:generate --force` makes new database passwords, but an existing database keeps the old ones, so follow it with `docker compose down -v`.

## 2.10 If something fails locally

| What you see | Why | What to do |
| --- | --- | --- |
| The dashboard won't start: `Can't resolve '@lobbystack/telemetry/node'` | The telemetry package isn't built | `pnpm --filter @lobbystack/telemetry build`, then `pnpm dev` |
| Onboarding stops at the plan step: `Can't resolve '@lobbystack/shared/product-capabilities'` | The shared package isn't built, on a copy older than `7893d2e` | `pnpm --filter @lobbystack/shared build`, then reload the page |
| Sign-in says "Incorrect email or password" although the password is right, and the terminal shows `Invalid origin` | The dashboard is open at an address other than `http://localhost:13000` | Use `http://localhost:13000` exactly |
| The sign-up code never arrives | No email is set up | Sign in with the same email and password, or set up Mailpit ([2.7](#27-optional-extras)) |
| `pnpm env:generate` says it generated 0 secrets | Windows line endings, in a clone made before fork PR #83 | `git pull`, then `pnpm env:generate --force` and `docker compose down -v` |
| Way B's build stops with `Review image lockfile projection for the new pnpm lockfile format` | `pnpm-lock.yaml` has Windows line endings, in a clone made before fork PR #83 | `git pull` for an image script that reads either line ending, then build again, or give every file LF ("Line endings on Windows" in `docs/voice/local-debugging.md`) |
| `.env already exists` | You already generated it | Keep it, or add `--force` and then run `docker compose down -v` |
| `required variable BETTER_AUTH_SECRET is missing a value` | There's no `.env` | `pnpm env:generate` |
| The apps can't sign in to the database: `password authentication failed` or `is not permitted to log in` | The database first started with other passwords, or with Windows line endings in a clone made before fork PR #83 | `git pull` for the line endings, then `docker compose down -v` and start again |
| A container keeps restarting with `must not use a placeholder value in production` (Way B) | `.env` was copied instead of generated | `pnpm env:generate --force`, then `docker compose down -v` |
| `Ports are not available` | Another program uses the port, or Windows reserved it. On Windows, IIS often holds port 80, which Way B's Caddy uses | Change the port in `.env`, along with the addresses that contain it. For Caddy, add `HTTP_PORT=8080` to `.env.local`; the dashboard stays at `http://localhost:13000` |
| Way B's build stops with `failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF` | Docker Desktop restarted during the build. On Windows, event 2004 in Event Viewer's System log means Windows ran low on virtual memory | Close programs you don't need or restart Windows, then build one image at a time with the same `--env-file` options: `build worker`, then `build admin`, then `up -d` |
| `429 Too Many Requests` while downloading an image | Docker Hub's limit for downloads without an account | `docker login`, or try again later |
| The worker stops with `listen EAFNOSUPPORT` | The computer has IPv6 switched off | Switch IPv6 back on |

**Checked against:** `docs/voice/local-debugging.md`, `docker-compose.yml`, `.env.example`, `.gitattributes`, `.github/build/prepare-image-workspace.mjs`, `docker/postgres/init/roles.sh`, `scripts/generate-env.mjs`, `scripts/dev.mjs`, `apps/admin/next.config.ts`, `apps/admin/tsconfig.json`, `apps/admin/src/components/auth-card.tsx`, `apps/admin/src/lib/auth.ts`, `apps/worker/src/health.ts`.
