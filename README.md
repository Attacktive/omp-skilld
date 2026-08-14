# omp-skilld

An unofficial [OMP](https://oh-my-pi.dev) plugin that keeps skills from GitHub repositories up to date, in the background.

`gh skill install --all` takes upwards of a minute, and OMP loads extensions before it scans for skills — so refreshing on the critical path would put that minute on every single launch.
Skilld fires the refresh off unawaited and lets the next launch pick up whatever landed, pinning what it is doing under the editor — and how it turned out — so a first run does not just sit there looking broken.
Downloads land in a directory of the plugin's own and are published into the one OMP already scans, so nothing has to be configured for a skill to show up.

> [!NOTE]
> Not built by the OMP team, and not affiliated with them in any way.
> Ported from [opencode-skilld](https://github.com/Attacktive/opencode-skilld), which discovers skills differently, so the paths are OMP's own here. A machine running both tools downloads each source twice unless `target` and `stamp` are pointed at the opencode ones.

## Requirements

- [`gh`](https://cli.github.com) on `PATH`, logged in, recent enough to have `gh skill` — which is itself in preview and "subject to change without notice", so an older `gh` will not have it at all.

A missing or unauthenticated `gh` is not fatal: you get an error toast and whatever skills you already had.

The skill API's rate limit is tight, and `--all` spends it per source, so the plugin is built to download each set of skills once rather than once per launch: a download that outlives its launch is finished and installed by the next one, and a failure is left alone for an hour instead of retried every time OMP starts.

## Install

From a local checkout, which needs nothing published or pushed:

```bash
omp plugin link /path/to/omp-skilld
```

A symlink rather than a copy, so edits are live on the next launch.

`install` also takes git specs — `github:user/repo[#ref]`, `gitlab:`, `bitbucket:`, `codeberg:`, `sourcehut:`, and full git URLs — so a pushed repository can be installed without publishing to npm:

```bash
omp plugin install github:Attacktive/omp-skilld
```

And once it is on npm, by name:

```bash
omp plugin install omp-skilld
```

All three land in `~/.omp/plugins/node_modules/omp-skilld` and are recorded in `~/.omp/plugins/omp-plugins.lock.json`.
`omp plugin list` shows it, `omp plugin doctor` checks it over, and `omp plugin uninstall omp-skilld` takes it out again.

Nothing refreshes until `sources` is set, so installing on its own is inert.

## Configure

Settings are stored in `~/.omp/plugins/omp-plugins.lock.json` and managed through the CLI:

```bash
omp plugin config set omp-skilld sources 'anthropics/skills'
omp plugin config list omp-skilld
```

`sources` takes a plain list, separated by commas or whitespace, and JSON for the sources that need more than a name:

```bash
omp plugin config set omp-skilld sources 'anthropics/skills, someone/their-skills'
omp plugin config set omp-skilld sources '[{"repo": "anthropics/skills", "target": "~/skills/anthropic"}]'
omp plugin config set omp-skilld interval 604800000
```

A project can override any of it for itself in `.omp/plugin-overrides.json`, which OMP looks for in the working directory — there and nowhere else, so the override that applies is always the one `omp plugin config list` would show. The plugin asks OMP for its settings rather than resolving them itself, so the lock is found wherever OMP keeps it — the XDG layout included — and a `plugin-overrides.json` that will not parse is skipped exactly the way OMP skips it:

```json
{
	"settings": {
		"omp-skilld": {
			"sources": "someone/their-skills"
		}
	}
}
```

That is the whole setup: OMP scans `~/.omp/agent/skills` on its own, and the plugin publishes each downloaded skill there as a symlink into `~/.omp/skilld/<slug>`, one link per skill.
Nothing has to be added to `config.yml`, and the links survive a refresh untouched — they point at a path inside the download, and a refresh only changes what that path holds.

A name you already hold there wins: a real directory of your own is never replaced, and the download keeps refreshing on disk in case you free the name later.
Publication runs on every launch rather than only after a download, so a name you give up — or a link you delete by hand — is repaired on the next launch.

```
~/.omp/skilld/anthropics-skills/pdf/SKILL.md                        the download
~/.omp/agent/skills/pdf -> ~/.omp/skilld/anthropics-skills/pdf      what OMP scans
```

To share one download with opencode-skilld, spell out the paths it uses:

```bash
omp plugin config set omp-skilld sources '[{"repo": "anthropics/skills", "target": "~/.local/share/opencode/skills/anthropic", "stamp": "~/.local/state/opencode/anthropic-skills-refreshed"}]'
```

With no `sources`, the plugin does nothing at all.

## Options

| Option     | Default           | Meaning                                                                                                        |
|------------|-------------------|----------------------------------------------------------------------------------------------------------------|
| `sources`  | `[]`              | Repositories to refresh from: a list of `owner/repo`, or JSON for the object form below.                       |
| `interval` | `86400000` (24 h) | How long a refresh stays fresh, in milliseconds. `0` refreshes every launch, which the rate limit will notice. |

A source given as an object can override what the bare `owner/repo` derives:

| Field         | Default                                | Meaning                                                                                                 |
|---------------|----------------------------------------|---------------------------------------------------------------------------------------------------------|
| `repo`        | —                                      | The GitHub `"owner/repo"` to install from. Required, and refused unless it looks like one.              |
| `target`      | `~/.omp/skilld/<slug>`                 | Where to install. `<slug>` is `repo` with `/` turned into `-`.                                          |
| `stamp`       | `~/.omp/skilld/.<slug>-refreshed`      | Where the last successful refresh is recorded.                                                          |
| `label`       | `repo`                                 | The name used in toasts.                                                                                |
| `placeholder` | `"template"`                           | The placeholder skill directory to drop from each download, or `false` to keep whatever upstream ships. |

The wholesale replacement a refresh performs is why `target` must not share a directory with anything else.
Pointing it at a directory OMP scans — `~/.omp/agent/skills`, say — looks like it would save a symlink, but the next refresh would stand one repository's download in for the *entire* directory: another source's skills, the ones you wrote by hand, all gone with it.
Give every source a directory of its own, and let publication be what puts skills where OMP looks.

Nothing above is enforced by the settings schema, so everything is validated at runtime.
Anything that does not match is ignored with an error toast rather than taken literally — an option with an unknown name, a `sources` that is neither a list nor JSON describing one, an entry that names no `repo` or names something that is not `owner/repo`, an entry giving `target`, `stamp` or `label` the wrong type or an empty string, an `interval` that is not a number.

A `~` on its own, or a leading `~/`, is expanded in `target` and `stamp`.
Nothing else is — not `$VAR`, not `~user` — because these go straight to `mkdirSync` and never near a shell.

### About `placeholder`

Repositories started from GitHub's skill template ship a `template/` skill described as *"Replace with description of the skill and when Claude should use it."* It has a description, so nothing filters it out, and a trigger that vague fires on almost anything.
Skilld drops it — but only when the directory still says that about itself, in its frontmatter `description`; a skill that merely quotes the phrase in its body is not touched.
A repository that ships a real skill called `template` keeps it, and a `template/` with no `SKILL.md` in it is left alone rather than guessed about.

Point `placeholder` at a different name if a repository calls its placeholder something else, or set it to `false` to skip the check entirely.

It has to be a single directory name. A `""`, a `"."`, a `".."` or anything with a separator in it is refused and nothing is deleted — the deletion is recursive, forced, and aimed inside the finished download, so an empty string would take the whole download with it and a `..` would climb out of it entirely.

## Finding sources

Discovery ships with the same `gh skill` preview the refresh depends on:

```bash
gh skill search terraform
gh skill preview anthropics/skills pdf
```

That searches skills, though, and `sources` takes repositories. Topic search finds those directly — and does not share the Code Search API's ten-a-minute limit:

```bash
gh api "search/repositories?q=topic:agent-skills&sort=stars&per_page=20" --jq '.items[] | "★\(.stargazers_count)\t\(.full_name)"'
```

Then check the layout before adding one, because `--all` means a source is a repository you want *whole*, every launch:

```bash
gh api repos/<owner>/<repo>/contents/skills --jq '.[] | .type + " " + .name'
```

A flat list of directories, and not too many. A repository that files skills by category — `skills/engineering/<name>/SKILL.md` — sits a level deeper than OMP looks, so the refresh succeeds and nothing loads.

## Behaviour

- Refreshes at most once per `interval` per source, tracked by a stamp file that is written **after** a refresh succeeds — so an interrupted one simply retries next launch.
- Downloads into a hidden staging directory beside `target` and stands it in for the live one only once `gh` has succeeded, so OMP never scans a half-written skill set. Beside it rather than under `TMPDIR` because a rename across filesystems fails, and hidden so a scan cannot mistake it for a skill. Nothing appears at `target` until a refresh has actually succeeded. Not a single atomic step — nothing Node exposes can exchange two directories — but the live directory is absent for two renames rather than for the length of a download, and a swap that fails puts the previous skills back rather than leaving a gap. A launch killed *between* those two renames leaves the previous skills parked beside the target, and the next launch stands them back in rather than sweeping them.
- A finished download that could not be installed — the target's parent unwritable, say — keeps its claim, so the next launch retries the install rather than paying for the download again.
- Never awaited, and the download is detached, so quitting OMP never waits on one — and never kills one either. A download that outlives its launch records how it ended beside the staging directory; the next launch installs a finished one instead of downloading it again. Two launches that find the same finished download cannot both install it: claiming it is a single unlink, and the one that loses it stands aside.
- A download still running is left alone, however short the interval. Each download records its process id beside its staging directory, so a launch asks the process itself: alive means left alone however quiet the directory, gone means swept at once — a reboot mid-download, say. Only a download with no pid to ask falls back to the clock: one whose staging area has seen no new file anywhere in fifteen minutes is taken for dead and swept, so the next attempt starts clean.
- A failed download is left alone for an hour before another is attempted, which is what keeps a rate limit or an expired login from costing an attempt per launch. Its staging directory is kept as the record of that failure, and swept when the hour is up. A `gh` that was never found, or could not be run, is exempt: none of the rate limit was spent, so installing it and relaunching refreshes at once instead of an hour later.
- Publishes into `~/.omp/agent/skills` as one symlink per skill, on every launch rather than only after a download, so a link deleted by hand or a name freed since the last refresh is repaired at once. A link into the download root is the plugin's to remove; anything else there is yours and is never touched, which is also how a skill dropped upstream gets its name freed again.
- A name already taken by a directory of your own is left alone rather than replaced, and reported to the log. The download still refreshes, so freeing the name is all it takes to get it.
- Nothing throws. A missing `gh`, an expired login, a plane — all of them degrade to an error toast, never a broken launch.
- Says everything twice on purpose, because the two surfaces lose different things. A toast is shown once and scrolls away with the transcript, which is exactly what a minute-long download outlives; a pin sits in the widget strip under the editor with a glyph and the source's name — `⟳` while it downloads, `✓` with the skill count when it lands, `✗` with the reason when it does not — and stays there until you start your next turn. A download still running keeps its pin through that turn, since it is not news to be dismissed. The status bar carries the same state in the few columns it has.
- Every outcome is written to OMP's log (`~/.omp/logs/omp.<date>.<pid>.log`) as well as toasted and pinned, because the launches that need explaining most — `omp -p`, a CI run — have no TUI for either.
- The "in the background" announcement is held back a few seconds, so a refresh that settles within the first beat — a missing `gh` fails in milliseconds — speaks for itself instead of arriving after a promise it already broke. Everything else is said the moment it happens; the pin goes up at once, since a pin that is superseded costs a line under the editor rather than a notification.
- The sweep runs once per launch, on the first session — subagents do not each get their own refresh.

## Windows

Children are not reaped with their parent there, so `gh` is spawned directly rather than through a shell: neither Git Bash nor WSL is involved.
The completion and failure markers are written by the plugin's own exit handler instead, so a download that ends while OMP is still running is recorded exactly as everywhere else — the failure cooldown included, which is what keeps an expired login from costing an attempt per launch.
The trade is that a download outliving its launch is not recorded, so it costs one redundant download rather than being installed by the next launch — the behaviour every platform had before the markers.
A `gh` installed as a `.cmd` shim cannot be spawned this way; that surfaces as a "could not refresh" error toast, and installing the real executable (winget, scoop, the MSI) is the fix.

`~` in `target` and `stamp` resolves through `os.homedir()`, which reads `USERPROFILE`.
Keep the forward slash after the tilde: `~\.local\share\...` is not expanded.

Publication uses junctions rather than symlinks, since those need no privileges and OMP's scan reads both the same way.

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
```

There is no build step — OMP loads the TypeScript directly.
The suite drives the plugin's own timer queue rather than the clock, so it finishes in well under a second.
