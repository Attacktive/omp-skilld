/*
 * Keeps configured skills current by re-installing them from GitHub in the background.
 * The refresh is never awaited: `gh skill install --all` takes upwards of a minute, and omp loads extensions before it scans for skills, so awaiting it would put that minute on every launch.
 * Whatever is downloaded is picked up on the next launch instead; a pin under the editor and a pair of toasts cover the wait, because a first launch that quietly comes up with no skills looks broken.
 * Nothing here is allowed to throw — a missing `gh` or an expired login degrades to an error toast and a pin saying why, never a broken launch.
 *
 * omp takes the module named in the plugin manifest's `extensions` entry and uses its default export as the factory, so that export is all this file offers; everything else lives in `internals.ts`, where it can be tested.
 */

import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ANNOUNCEMENT_DELAY_MS, DEFAULT_INTERVAL_MS, NOT_EXECUTABLE, NOT_FOUND, PLUGIN_NAME, asInterval, complaint, reason, asSources, dropPlaceholder, installCommand, isEmpty, isSource, isStale, layout, linkSkills, normalize, readPluginSettings, resolveStaging, settleParked, staging, swap, sweepGuard, type Layout, type NormalizedSource, type Options, type SkillSource, type StagingState } from './internals.ts';

/** Exhaustive against {@link Options} by construction: a key added there refuses to compile until it is mirrored here. */
const KNOWN_OPTIONS: Record<keyof Options, null> = { sources: null, interval: null };

/** The plugin's only voice. Fire-and-forget by design, so nothing that happens to a toast can ever surface as an error. */
type Toast = (message: string, variant: 'info' | 'warning' | 'error') => void;

/** Where a refresh says what it did regardless of whether anyone is looking: toasts need a TUI, and the launches that need explaining most — `omp -p`, a CI run — have none. */
type Log = (message: string) => void;

/**
 * Everything a refresh can say, and the two places it says it: a toast, which omp shows once and forgets, and a pin, which stays put until the news has been seen.
 * A download runs for a minute, and a minute of transcript is exactly what buries a toast — so the pin is the same news somewhere it cannot scroll away.
 */
interface Voice {
	/** Fire-and-forget by design, so nothing that happens to a toast can ever surface as an error. */
	toast: Toast;
	/** Holds a source in view for as long as its download runs. */
	working: (label: string, detail: string) => void;
	/** Replaces a source's pin with how the refresh turned out. `ok` picks the glyph and the colour; `status` is the same news in the few columns the status bar has. */
	settled: (label: string, ok: boolean, detail: string, status: string) => void;
	/** Takes down the pins whose news has been seen, which is what starting a turn means. A download still running keeps its pin: that one is not news, it is work in progress. */
	release: () => void;
}

/** What a pin calls this plugin: `omp-skilld` is the package, and a status bar has no columns to spare for the prefix. */
const BANNER = 'skilld';

/** The three colours a pin comes in, each one omp's own — a pin is painted by whatever theme is loaded rather than in colours of its own choosing. */
type Colour = 'accent' | 'success' | 'error';

/**
 * Pins go in the widget strip under the editor and in the status bar, neither of which exists without a TUI.
 * Every call is guarded: a headless launch, a host whose `ctx.ui` predates widgets, or a session torn down mid-download all fall back to the log, which has the whole story regardless.
 */
const pinboard = (ctx: ExtensionContext): Voice => {
	/** The labels whose pin is settled news, which are the only ones {@link Voice.release} may take down. */
	const seen: Record<string, true> = {};

	const key = (label: string) => `${PLUGIN_NAME}:${label}`;

	const pin = (label: string, colour: Colour, glyph: string, detail: string, status: string) => {
		try {
			const { theme } = ctx.ui;

			// A bar and a glyph in the pin's colour, the name in bold, the detail dimmed: loud enough to catch an eye on the editor, quiet enough to sit under one.
			ctx.ui.setWidget(key(label), [`${theme.fg(colour, `▌ ${glyph}`)} ${theme.bold(BANNER)} ${theme.fg('dim', `· ${detail}`)}`], { placement: 'belowEditor' });

			// Where the news survives a screen that has pushed the widget strip out of sight, in the handful of columns such a place has.
			ctx.ui.setStatus(key(label), theme.fg(colour, `${glyph} ${status}`));
		} catch {
			// A mode with no widget strip, or a session already gone: the toast and the log say the same thing.
		}
	};

	const unpin = (label: string) => {
		try {
			ctx.ui.setWidget(key(label), undefined);
			ctx.ui.setStatus(key(label), undefined);
		} catch {
			// Nothing left to take down is the state this was aiming for.
		}
	};

	return {
		/*
		 * Straight through: `ctx.ui` is wired before `session_start` is emitted in every omp mode — the real UI when there is one, a permanent no-op when there is not (`ctx.hasUI` says which) — so holding a toast back buys nothing and would only delay every error by the hold.
		 * Headless launches still get the whole story through the log.
		 */
		toast: (message, variant) => {
			try {
				ctx.ui.notify(message, variant);
			} catch {
				// The session may have ended while the refresh was still running; there is nowhere left to say it.
			}
		},
		working: (label, detail) => {
			// A source that failed last launch and is being tried again this one has an old pin standing; it is superseded, not news, so it is no longer `release`'s to take down.
			delete seen[label];

			pin(label, 'accent', '⟳', detail, 'skills');
		},
		settled: (label, ok, detail, status) => {
			seen[label] = true;

			if (ok) {
				pin(label, 'success', '✓', detail, status);
				return;
			}

			pin(label, 'error', '✗', detail, status);
		},
		release: () => {
			for (const label of Object.keys(seen)) {
				delete seen[label];
				unpin(label);
			}
		}
	};
};

/** The voice of the session that ran the sweep, so the `turn_start` handler — registered at load, which is the only place registration belongs — can reach the pins that sweep put up. */
let sessionVoice: Voice | undefined;

/**
 * Starts the download and leaves it running.
 * Detached so it survives omp quitting: omp takes its process group with it, and a refresh that dies mid-download restarts from scratch on every launch — expensive against the skill API's rate limit.
 * A shell wraps `gh` only so that something which outlives this process can record how the download ended; the plugin's own handlers die with the parent.
 * Windows does not reap children with their parent, so there `gh` is spawned directly and the markers are the launch's own business.
 */
const download = (repo: string, incoming: string, done: string, failed: string, pid: string, noise: string) => {
	let child;

	if (process.platform === 'win32') {
		/*
		 * Where the shell's `2>` does the same job everywhere else: an exit code says a download failed, and only `gh` can say why.
		 * A file that will not open costs the explanation and nothing more, so the download still goes ahead with the stream discarded.
		 */
		let stderr: number | 'ignore' = 'ignore';

		try {
			stderr = openSync(noise, 'w');
		} catch {
			// Nothing to read back later, which is where a missing complaint is already handled.
		}

		child = spawn('gh', ['skill', 'install', repo, '--all', '--dir', incoming, '--force'], { stdio: ['ignore', 'ignore', stderr], detached: true });

		if (stderr !== 'ignore') {
			try {
				// The child holds its own copy from the moment it was spawned; this one would otherwise be leaked for the life of the launch.
				closeSync(stderr);
			} catch {
				// A descriptor that will not close is a descriptor the launch keeps, which is not worth failing a download over.
			}
		}
	} else {
		child = spawn('sh', ['-c', installCommand(repo, incoming, done, failed, noise)], { stdio: 'ignore', detached: true });
	}

	/*
	 * Who is downloading, for the launches that come while it still is: a live pid protects a quiet download from the abandonment sweep, and a dead one frees the staging area without waiting out the clock.
	 * A marker that would not write is no failure — the mtime fallback still speaks.
	 */
	if (child.pid !== undefined) {
		try {
			writeFileSync(pid, String(child.pid));
		} catch {
			// The mtime fallback still speaks.
		}
	}

	return child;
};

/**
 * Publishes what is on disk into the skills directory omp scans, on every launch rather than only after a download: a name the user has since given up, or a link they deleted by hand, is repaired on the next launch instead of waiting for the next refresh.
 * Nothing is said about the links that were already right, since that is the common case — a name standing aside is repeated every launch, because it is the answer to why a skill never showed up.
 * Never fatal: the skills are installed either way, so a link that could not be written is worth saying out loud rather than failing a refresh over.
 */
const publish = (source: NormalizedSource, linkRoot: string, voice: Voice, log: Log) => {
	try {
		const { skills, linked, refused } = linkSkills(source.target, linkRoot);

		if (linked.length > 0) {
			log(`${source.label}: linked ${linked.length} skill(s) into ${linkRoot}`);
		}

		if (refused.length > 0) {
			// Theirs outranks a download: the skill is still refreshed on disk, and the name is tried again next launch in case it has been given up since.
			log(`${source.label}: not linked, since you have skills of those names already: ${refused.join(', ')}`);
		}

		// What omp will see of this source, which is every skill in it bar the names that were already somebody else's.
		return skills.length - refused.length;
	} catch (cause) {
		log(`${source.label}: could not link into ${linkRoot}: ${reason(cause)}`);
		voice.toast(`Refreshed ${source.label}, but could not publish it into ${linkRoot}.`, 'error');

		return 0;
	}
};

/** A finished download becomes the live directory, its stamp is recorded, and the completion markers make way for the next refresh. Shared by the in-process exit handler and the launch that finds a finished download left behind by a dead one. */
const complete = (source: NormalizedSource, dirs: Layout, voice: Voice, log: Log) => {
	const { target, stamp } = source;
	const { incoming, done, failed, pid, noise } = staging(target);

	/*
	 * Unlinking the marker is how a launch claims the download: two started close enough together both find it finished, and only one unlink can succeed.
	 * Everyone who calls this holds a marker — the exit handler writes one before calling, every platform included — so a marker already gone means the claim is lost, and the loser bows out instead of racing the winner's swap and reporting an install failure that never happened.
	 */
	try {
		rmSync(done);
	} catch {
		log(`${source.label}: another launch is installing this download`);
		return;
	}

	const first = isEmpty(target);

	try {
		if (dropPlaceholder(incoming, source.placeholder)) {
			log(`${source.label}: dropped the \`${source.placeholder}\` placeholder skill`);
		}

		// The download becomes the live directory only once it is whole, so nothing ever scans a half-written one.
		swap(target);
	} catch (cause) {
		/*
		 * A download that is still whole gets its claim back, so the next launch retries the install instead of paying for the download again.
		 * Only then: re-arming a marker with nothing behind it would loop the same failure once per launch forever.
		 */
		if (existsSync(incoming)) {
			try {
				writeFileSync(done, '');
			} catch {
				// The next launch downloads again instead, which is the cost this marker exists to avoid — not a new failure.
			}
		}

		log(`${source.label}: could not install the download: ${reason(cause)}`);
		voice.toast(`Downloaded ${source.label}, but could not install it — the skills you already had are untouched.`, 'error');
		voice.settled(source.label, false, `downloaded ${source.label}, but could not install it — the skills you already had are untouched`, 'install failed');

		return;
	}

	try {
		mkdirSync(dirname(stamp), { recursive: true });

		// Written last, so it records a refresh that actually finished and nothing else.
		writeFileSync(stamp, '');
	} catch (cause) {
		log(`${source.label}: installed, but could not write ${stamp}: ${reason(cause)}`);
		voice.toast(`Refreshed ${source.label}, but could not record it — expect a redundant download next launch.`, 'error');
		voice.settled(source.label, false, `refreshed ${source.label}, but could not record it — expect a redundant download next launch`, 'stamp failed');

		return;
	}

	rmSync(failed, { force: true });
	rmSync(pid, { force: true });

	// Whatever `gh` grumbled on its way to succeeding is spent news, and a complaint left lying beside a working install is one a later failure would repeat as its own.
	rmSync(noise, { force: true });

	const published = publish(source, dirs.linkRoot, voice, log);

	log(`${source.label}: installed into ${target}`);

	let message = `${source.label} has been refreshed.\nRestart omp to pick up any changes.`;
	let pinned = `${published} skill(s) refreshed · restart omp to pick them up`;

	if (first) {
		message = `${source.label} is ready.\nRestart omp to load it.`;
		pinned = `${published} skill(s) ready · restart omp to load them`;
	}

	voice.toast(message, 'info');
	voice.settled(source.label, true, pinned, `${published} skills`);
};

/** Whether the staging area leaves this launch a download to start, having said in the log what it found — and installed it, if that is what was waiting. */
const proceed = (state: StagingState, source: NormalizedSource, dirs: Layout, voice: Voice, log: Log) => {
	switch (state) {
		case 'finish':
			log(`${source.label}: a download finished after the launch that started it; installing it now`);
			complete(source, dirs, voice, log);

			return false;

		case 'in-flight':
			log(`${source.label}: a download is still running; leaving it alone`);

			return false;

		case 'cooling':
			log(`${source.label}: the last download failed recently; not trying again yet`);

			return false;

		case 'failed':
			log(`${source.label}: the last download failed long enough ago to try again`);

			return true;

		default:
			return true;
	}
};

/** Fires one source's refresh off in the background and never waits on it. */
const refresh = (configured: SkillSource, dirs: Layout, staleAfter: number, voice: Voice, log: Log, ctx: ExtensionContext) => {
	// The catch at the bottom needs a name for the source no matter how little of the body ran.
	let label = JSON.stringify(configured);

	let notice: Timer | undefined;

	try {
		const source = normalize(configured, dirs.root);
		label = source.label;

		const { repo, target, stamp } = source;
		const { incoming, done, failed, pid, noise } = staging(target);

		/*
		 * Only the parent, which is where staging goes.
		 * `target` itself appears once a refresh has actually succeeded, so an interrupted one leaves nothing that reads as an installed-but-empty skill set.
		 */
		mkdirSync(dirname(target), { recursive: true });

		/*
		 * A parked directory can never be swapped in by the launch that parked it — that handler died with the parent — so it is settled here: discarded when the live directory stands, stood back in when a swap died between its two renames and the park is the only copy of the skills left.
		 * Before publication, so skills recovered this way are linked on the same launch that recovers them.
		 */
		if (settleParked(target)) {
			log(`${label}: restored the skills a failed swap left parked`);
		}

		if (existsSync(target)) {
			publish(source, dirs.linkRoot, voice, log);
		}

		if (!proceed(resolveStaging(target, stamp, staleAfter), source, dirs, voice, log)) {
			return;
		}

		if (!isStale(stamp, staleAfter)) {
			log(`${label}: refreshed within the last ${staleAfter} ms; nothing to do`);
			return;
		}

		let announcement = `Refreshing ${label} from GitHub in the background.\nCarry on working — you will get a second message once it is done.`;

		/** The same wait, in the one line a pin gets. */
		let progress = `refreshing ${label} from GitHub in the background`;

		const first = isEmpty(target);

		if (first) {
			announcement = `Fetching ${label} from GitHub in the background.\nThis usually takes a minute or so — carry on working, and you will get a second message the moment it is ready.`;
			progress = `fetching ${label} from GitHub — a minute or so; carry on working`;
		}

		/*
		 * Cancelled the moment the refresh settles: one that beats the TUI to it would otherwise promise a second message it has already sent, and a missing `gh` — which fails within milliseconds — would announce a download that never started.
		 */
		notice = ctx.setTimeout(() => voice.toast(announcement, 'info'), ANNOUNCEMENT_DELAY_MS);

		const install = download(repo, incoming, done, failed, pid, noise);

		log(`${label}: downloading into ${incoming}`);

		/*
		 * Unlike the announcement, which waits out the delay: a pin costs a line under the editor rather than a notification, and a download that fails in milliseconds simply replaces it with why.
		 */
		voice.working(label, progress);

		// Node warns that `exit` may or may not follow `error`, so whichever fires first speaks for the child.
		let settled = false;

		/*
		 * Runs as a bare listener on the child, where an exception that escapes becomes omp's postmortem — the whole session dying over a marker that would not delete.
		 * Hence the guarded steps: no failure among them may rob the others, and none may escape.
		 */
		const finish = (speak: () => void) => {
			if (settled) {
				return;
			}

			settled = true;

			try {
				// The child is gone whichever way this was reached, so the liveness marker goes with it.
				rmSync(pid, { force: true });
			} catch {
				// A marker that will not delete reads as a dead pid to the next launch, which draws the same conclusion.
			}

			try {
				if (notice !== undefined) {
					ctx.clearTimer(notice);
				}
			} catch {
				// A session torn down mid-download has no timers left to clear.
			}

			try {
				speak();
			} catch (cause) {
				log(`${label}: ${reason(cause)}`);
			}
		};

		/**
		 * The same failure with `gh`'s own account of it appended, when it left one.
		 * An exit code says a download failed; a name that collided, a login that expired, a repository that is not there are all things only `gh` can say, and it says them on the stream the download kept.
		 */
		const withComplaint = (detail: string) => {
			const said = complaint(noise);
			if (said === undefined) {
				return detail;
			}

			return `${detail}: ${said}`;
		};

		/** Every way a download that did start can fail: the log gets the detail, the toast gets the same detail in parentheses, and the pin holds it until it has been seen. */
		const speakOnFailure = (detail: string) => () => {
			log(`${label}: ${detail}`);
			voice.toast(`Failed to refresh ${label} (${detail}).`, 'error');
			voice.settled(label, false, `could not refresh ${label}: ${detail}`, 'refresh failed');
		};

		/**
		 * Something stopped the child from ever running: `sh` on POSIX, `gh` itself on Windows, where it is spawned directly.
		 * A missing `gh` is not this — the shell starts perfectly well and reports it as an exit code — so this reports the cause it was handed rather than guessing at one.
		 */
		const onError = (cause: unknown) => {
			const speak = () => {
				const detail = reason(cause);

				log(`${label}: could not start the download: ${detail}`);
				voice.toast(`Could not refresh ${label}: ${detail}`, 'error');
				voice.settled(label, false, `could not start the download for ${label}: ${detail}`, 'refresh failed');
			};

			finish(speak);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (signal !== null) {
				const speak = speakOnFailure(withComplaint(`\`gh\` was killed by ${signal}`));

				finish(() => {
					// A killed download leaves a half-written directory nothing will ever finish; sweeping it now spares the next launch the abandonment clock.
					rmSync(incoming, { recursive: true, force: true });

					speak();
				});

				return;
			}

			// The shell's verdict on a `gh` it could not run, which is what a missing `gh` looks like everywhere the download goes through `sh`.
			if (code === NOT_FOUND || code === NOT_EXECUTABLE) {
				finish(speakOnFailure('`gh` is not installed, or not on PATH'));
				return;
			}

			if (code !== 0) {
				const speak = speakOnFailure(withComplaint(`\`gh\` exited with code ${code}`));

				finish(() => {
					/*
					 * Windows parity for the cooldown: the wrapper writes this marker everywhere the download goes through `sh`, but a `gh` spawned bare records nothing, and an expired login would otherwise cost an attempt per launch.
					 * Everywhere else it is already on disk, and rewriting it only freshens the mtime the cooldown reads.
					 */
					writeFileSync(failed, '');

					speak();
				});

				return;
			}

			/*
			 * In-process fast path for a launch that lives to see it; the marker left behind lets a later launch finish the job.
			 * Written here as well as by the wrapper, because on Windows this is the only writer there is — and the claim inside `complete` expects every caller to hold one.
			 */
			finish(() => {
				writeFileSync(done, '');

				complete(source, dirs, voice, log);
			});
		};

		install.on('error', onError);
		install.on('exit', onExit);

		/*
		* Quitting omp must never wait on a download, so the child is unreferenced — orphaned rather than killed.
		* A download that outlives its launch finishes on its own and is stood in by the next one.
		*/
		install.unref();
	} catch (cause) {
		if (notice !== undefined) {
			ctx.clearTimer(notice);
		}

		log(`${label}: ${reason(cause)}`);
		voice.toast(`Could not refresh ${label}.`, 'error');
		voice.settled(label, false, `could not refresh ${label}`, 'refresh failed');
	}
};

const sweep = async (agentDir: string, cwd: string, voice: Voice, log: Log, ctx: ExtensionContext) => {
	const { options: given, error } = await readPluginSettings(cwd);

	if (error !== undefined) {
		log(`could not read the settings: ${error}`);
		voice.toast(`Could not read the ${PLUGIN_NAME} settings: ${error}`, 'error');
		return;
	}

	// A typo'd key would otherwise make the plugin indistinguishable from one that was never configured. Own properties only, or a key like `toString` would slip through by inheritance.
	const strangers = Object.keys(given)
		.filter((key) => !Object.hasOwn(KNOWN_OPTIONS, key));

	if (strangers.length > 0) {
		voice.toast(`Ignoring unknown options: ${strangers.map((stranger) => `\`${stranger}\``).join(', ')}. The options are \`sources\` and \`interval\`.`, 'error');
	}

	const sources = asSources(given.sources ?? []);

	if (sources === undefined) {
		log(`\`sources\` is neither a list of repositories nor JSON describing one: ${JSON.stringify(given.sources)}`);
		voice.toast('Ignoring `sources`: it has to be a list of repositories, such as `anthropics/skills`.', 'error');
		return;
	}

	let staleAfter = asInterval(given.interval);

	if (staleAfter === undefined) {
		voice.toast(`Ignoring \`interval\`: ${JSON.stringify(given.interval)} is not a number of milliseconds.`, 'error');
		staleAfter = DEFAULT_INTERVAL_MS;
	}

	const dirs = layout(agentDir);

	for (const configured of sources) {
		if (!isSource(configured)) {
			log(`ignoring a malformed source: ${JSON.stringify(configured)}`);
			voice.toast(`Ignoring a malformed source: ${JSON.stringify(configured)}. A source is an \`owner/repo\`, or an object naming one.`, 'error');
			continue;
		}

		refresh(configured, dirs, staleAfter, voice, log, ctx);
	}
};

const plugin = (pi: ExtensionAPI): void => {
	/*
	 * A settled pin is news until the user gets back to work, and starting a turn is what that looks like.
	 * Registered here rather than from inside `session_start`, since the load phase is where omp takes registrations.
	 */
	pi.on('turn_start', () => sessionVoice?.release());

	/*
	 * The extension factory runs once per session — subagents included — so the sweep is guarded to once per process.
	 * A second session inside the same launch has nothing to add: the stamp records freshness, and the staging sweep already ran.
	 */
	pi.on('session_start', (_event, ctx) => {
		if (sweepGuard.done) {
			return;
		}

		sweepGuard.done = true;

		let agentDir: string;

		try {
			agentDir = pi.pi.settings.getAgentDir();
		} catch {
			agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
		}

		const log: Log = (message) => {
			try {
				pi.pi.logger.info(`[${PLUGIN_NAME}] ${message}`);
			} catch {
				// A plugin that cannot log is still a plugin that refreshes skills.
			}
		};

		sessionVoice = pinboard(ctx);

		// Recorded rather than awaited: the launch never waits on the sweep, but the tests need to.
		sweepGuard.settled = sweep(agentDir, ctx.cwd, sessionVoice, log, ctx);
	});
};

export default plugin;
