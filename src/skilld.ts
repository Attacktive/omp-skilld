/*
 * Keeps configured skills current by re-installing them from GitHub in the background.
 * The refresh is never awaited: `gh skill install --all` takes upwards of a minute, and omp loads extensions before it scans for skills, so awaiting it would put that minute on every launch.
 * Whatever is downloaded is picked up on the next launch instead; two toasts cover the wait, because a first launch that quietly comes up with no skills looks broken.
 * Nothing here is allowed to throw — a missing `gh` or an expired login degrades to an error toast, never a broken launch.
 *
 * omp takes the module named in the plugin manifest's `extensions` entry and uses its default export as the factory, so that export is all this file offers; everything else lives in `internals.ts`, where it can be tested.
 */

import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_INTERVAL_MS, NOT_EXECUTABLE, NOT_FOUND, PLUGIN_NAME, TOAST_DELAY_MS, asInterval, asSources, dropPlaceholder, installCommand, isEmpty, isSource, isStale, layout, linkSkills, normalize, readPluginSettings, resolveStaging, staging, swap, sweepGuard, type Layout, type NormalizedSource, type Options, type SkillSource, type StagingState } from './internals.ts';

/** Exhaustive against {@link Options} by construction: a key added there refuses to compile until it is mirrored here. */
const KNOWN_OPTIONS: Record<keyof Options, null> = { sources: null, interval: null };

/** The plugin's only voice. Fire-and-forget by design, so nothing that happens to a toast can ever surface as an error. */
type Toast = (message: string, variant: 'info' | 'warning' | 'error') => void;

/** Where a refresh says what it did regardless of whether anyone is looking: toasts need a TUI, and the launches that need explaining most — `omp -p`, a CI run — have none. */
type Log = (message: string) => void;

/** What went wrong, in the one form a log line can carry. */
const reason = (cause: unknown) => {
	if (cause instanceof Error) {
		return cause.message;
	}

	return String(cause);
};

/**
 * Starts the download and leaves it running.
 * Detached so it survives omp quitting: omp takes its process group with it, and a refresh that dies mid-download restarts from scratch on every launch — expensive against the skill API's rate limit.
 * A shell wraps `gh` only so that something which outlives this process can record how the download ended; the plugin's own handlers die with the parent.
 * Windows does not reap children with their parent, so there `gh` is spawned directly and the markers are the launch's own business.
 */
const download = (repo: string, incoming: string, done: string, failed: string) => {
	if (process.platform === 'win32') {
		return spawn('gh', ['skill', 'install', repo, '--all', '--dir', incoming, '--force'], { stdio: 'ignore', detached: true });
	}

	return spawn('sh', ['-c', installCommand(repo, incoming, done, failed)], { stdio: 'ignore', detached: true });
};

/**
 * Publishes what is on disk into the skills directory omp scans, on every launch rather than only after a download: a name the user has since given up, or a link they deleted by hand, is repaired on the next launch instead of waiting for the next refresh.
 * Nothing is said about the links that were already right, since that is the common case — a name standing aside is repeated every launch, because it is the answer to why a skill never showed up.
 * Never fatal: the skills are installed either way, so a link that could not be written is worth saying out loud rather than failing a refresh over.
 */
const publish = (source: NormalizedSource, linkRoot: string, toast: Toast, log: Log) => {
	try {
		const { linked, refused } = linkSkills(source.target, linkRoot);

		if (linked.length > 0) {
			log(`${source.label}: linked ${linked.length} skill(s) into ${linkRoot}`);
		}

		if (refused.length > 0) {
			// Theirs outranks a download: the skill is still refreshed on disk, and the name is tried again next launch in case it has been given up since.
			log(`${source.label}: not linked, since you have skills of those names already: ${refused.join(', ')}`);
		}
	} catch (cause) {
		log(`${source.label}: could not link into ${linkRoot}: ${reason(cause)}`);
		toast(`Refreshed ${source.label}, but could not publish it into ${linkRoot}.`, 'error');
	}
};

/** A finished download becomes the live directory, its stamp is recorded, and the completion markers make way for the next refresh. Shared by the in-process exit handler and the launch that finds a finished download left behind by a dead one. */
const complete = (source: NormalizedSource, dirs: Layout, toast: Toast, log: Log) => {
	const { target, stamp } = source;
	const { incoming, done, failed } = staging(target);

	/*
	 * Unlinking the marker is how a launch claims the download: two started close enough together both find it finished, and only one unlink can succeed.
	 * The loser bows out instead of racing the winner's swap and reporting an install failure that never happened.
	 */
	if (existsSync(done)) {
		try {
			rmSync(done);
		} catch {
			log(`${source.label}: another launch is installing this download`);
			return;
		}
	}

	const first = isEmpty(target);

	try {
		if (dropPlaceholder(incoming, source.placeholder)) {
			log(`${source.label}: dropped the \`${source.placeholder}\` placeholder skill`);
		}

		// The download becomes the live directory only once it is whole, so nothing ever scans a half-written one.
		swap(target);
	} catch (cause) {
		log(`${source.label}: could not install the download: ${reason(cause)}`);
		toast(`Downloaded ${source.label}, but could not install it — the skills you already had are untouched.`, 'error');
		return;
	}

	try {
		mkdirSync(dirname(stamp), { recursive: true });

		// Written last, so it records a refresh that actually finished and nothing else.
		writeFileSync(stamp, '');
	} catch (cause) {
		log(`${source.label}: installed, but could not write ${stamp}: ${reason(cause)}`);
		toast(`Refreshed ${source.label}, but could not record it — expect a redundant download next launch.`, 'error');
		return;
	}

	rmSync(failed, { force: true });

	publish(source, dirs.linkRoot, toast, log);

	log(`${source.label}: installed into ${target}`);

	let message = `${source.label} has been refreshed.\nRestart omp to pick up any changes.`;

	if (first) {
		message = `${source.label} is ready.\nRestart omp to load it.`;
	}

	toast(message, 'info');
};

/** Whether the staging area leaves this launch a download to start, having said in the log what it found — and installed it, if that is what was waiting. */
const proceed = (state: StagingState, source: NormalizedSource, dirs: Layout, toast: Toast, log: Log) => {
	switch (state) {
		case 'finish':
			log(`${source.label}: a download finished after the launch that started it; installing it now`);
			complete(source, dirs, toast, log);

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
const refresh = (configured: SkillSource, dirs: Layout, staleAfter: number, toast: Toast, log: Log, ctx: ExtensionContext) => {
	// The catch at the bottom needs a name for the source no matter how little of the body ran.
	let label = JSON.stringify(configured);

	let notice: Timer | undefined;

	try {
		const source = normalize(configured, dirs.root);
		label = source.label;

		const { repo, target, stamp } = source;
		const { incoming, outgoing, done, failed } = staging(target);

		if (existsSync(target)) {
			publish(source, dirs.linkRoot, toast, log);
		}

		/*
		 * Only the parent, which is where staging goes.
		 * `target` itself appears once a refresh has actually succeeded, so an interrupted one leaves nothing that reads as an installed-but-empty skill set.
		 */
		mkdirSync(dirname(target), { recursive: true });

		// A parked directory can never be swapped in by the launch that parked it — that handler died with the parent — so discarding it is always correct.
		rmSync(outgoing, { recursive: true, force: true });

		if (!proceed(resolveStaging(target, stamp, staleAfter), source, dirs, toast, log)) {
			return;
		}

		if (!isStale(stamp, staleAfter)) {
			log(`${label}: refreshed within the last ${staleAfter} ms; nothing to do`);
			return;
		}

		let announcement = `Refreshing ${label} from GitHub in the background.\nCarry on working — you will get a second message once it is done.`;

		const first = isEmpty(target);

		if (first) {
			announcement = `Fetching ${label} from GitHub in the background.\nThis usually takes a minute or so — carry on working, and you will get a second message the moment it is ready.`;
		}

		/*
		 * Cancelled the moment the refresh settles: one that beats the TUI to it would otherwise promise a second message it has already sent, and a missing `gh` — which fails within milliseconds — would announce a download that never started.
		 */
		notice = ctx.setTimeout(() => toast(announcement, 'info'), TOAST_DELAY_MS);

		const install = download(repo, incoming, done, failed);

		log(`${label}: downloading into ${incoming}`);

		// Node warns that `exit` may or may not follow `error`, so whichever fires first speaks for the child.
		let settled = false;

		const finish = (speak: () => void) => {
			if (settled) {
				return;
			}

			settled = true;

			if (notice !== undefined) {
				ctx.clearTimer(notice);
			}

			speak();
		};

		/** Every way a download that did start can fail: the log gets the detail, the toast gets the same detail in parentheses. */
		const speakOnFailure = (detail: string) => () => {
			log(`${label}: ${detail}`);
			toast(`Failed to refresh ${label} (${detail}).`, 'error');
		};

		/**
		 * Something stopped the child from ever running: `sh` on POSIX, `gh` itself on Windows, where it is spawned directly.
		 * A missing `gh` is not this — the shell starts perfectly well and reports it as an exit code — so this reports the cause it was handed rather than guessing at one.
		 */
		const onError = (cause: unknown) => {
			const speak = () => {
				const detail = reason(cause);

				log(`${label}: could not start the download: ${detail}`);
				toast(`Could not refresh ${label}: ${detail}`, 'error');
			};

			finish(speak);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (signal !== null) {
				finish(speakOnFailure(`\`gh\` was killed by ${signal}`));
				return;
			}

			// The shell's verdict on a `gh` it could not run, which is what a missing `gh` looks like everywhere the download goes through `sh`.
			if (code === NOT_FOUND || code === NOT_EXECUTABLE) {
				finish(speakOnFailure('`gh` is not installed, or not on PATH'));
				return;
			}

			if (code !== 0) {
				finish(speakOnFailure(`\`gh\` exited with code ${code}`));
				return;
			}

			// In-process fast path for a launch that lives to see it; the marker left behind lets a later launch finish the job.
			finish(() => complete(source, dirs, toast, log));
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
		toast(`Could not refresh ${label}.`, 'error');
	}
};

const sweep = async (agentDir: string, cwd: string, toast: Toast, log: Log, ctx: ExtensionContext) => {
	const { options: given, error } = await readPluginSettings(agentDir, cwd);

	if (error !== undefined) {
		log(`could not read the settings: ${error}`);
		toast(`Could not read the ${PLUGIN_NAME} settings: ${error}`, 'error');
		return;
	}

	// A typo'd key would otherwise make the plugin indistinguishable from one that was never configured.
	const strangers = Object.keys(given).filter((key) => !(key in KNOWN_OPTIONS));

	if (strangers.length > 0) {
		toast(`Ignoring unknown options: ${strangers.map((stranger) => `\`${stranger}\``).join(', ')}. The options are \`sources\` and \`interval\`.`, 'error');
	}

	const sources = asSources(given.sources ?? []);

	if (sources === undefined) {
		log(`\`sources\` is neither a list of repositories nor JSON describing one: ${JSON.stringify(given.sources)}`);
		toast('Ignoring `sources`: it has to be a list of repositories, such as `anthropics/skills`.', 'error');
		return;
	}

	let staleAfter = asInterval(given.interval);

	if (staleAfter === undefined) {
		toast(`Ignoring \`interval\`: ${JSON.stringify(given.interval)} is not a number of milliseconds.`, 'error');
		staleAfter = DEFAULT_INTERVAL_MS;
	}

	const dirs = layout(agentDir);

	for (const configured of sources) {
		if (!isSource(configured)) {
			log(`ignoring a malformed source: ${JSON.stringify(configured)}`);
			toast(`Ignoring a malformed source: ${JSON.stringify(configured)}. A source is an \`owner/repo\`, or an object naming one.`, 'error');
			continue;
		}

		refresh(configured, dirs, staleAfter, toast, log, ctx);
	}
};

const plugin = (pi: ExtensionAPI): void => {
	/*
	 * The extension factory runs once per session — subagents included — so the sweep is guarded to once per process.
	 * A second session inside the same launch has nothing to add: the stamp records freshness, and the staging sweep already ran.
	 */
	pi.on('session_start', (_event, ctx) => {
		if (sweepGuard.done) {
			return;
		}

		sweepGuard.done = true;

		const started = Date.now();

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

		/*
		 * Held back until the TUI can be listening: extensions are loaded before it attaches, and until it does `ctx.ui` is a set of no-ops, so a toast sent early is not delayed but lost.
		 * Everything past that floor goes out as it happens, and the log has the whole story either way.
		 */
		const toast: Toast = (message, variant) => {
			const held = ctx.setTimeout(
				() => {
					try {
						ctx.ui.notify(message, variant);
					} catch {
						// The session may have ended while the refresh was still running; there is nowhere left to say it.
					}
				},
				Math.max(0, TOAST_DELAY_MS - (Date.now() - started))
			);

			// A pending toast must never be what keeps omp from exiting.
			held.unref?.();
		};

		void sweep(agentDir, ctx.cwd, toast, log, ctx);
	});
};

export default plugin;
