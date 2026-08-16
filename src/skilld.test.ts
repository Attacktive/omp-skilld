import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { getPluginsLockfile, refreshDirsFromEnv } from '@oh-my-pi/pi-utils';
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as pluginModule from './skilld.ts';
import plugin from './skilld.ts';
import { ABANDONED_MS, DEFAULT_INTERVAL_MS, FAILURE_COOLDOWN_MS, NOT_EXECUTABLE, NOT_FOUND, PLUGIN_NAME, asInterval, asPlaceholder, asSources, complaint, dropPlaceholder, expand, installCommand, isEmpty, isRepo, isSource, isStale, layout, linkSkills, normalize, unlink, readPluginSettings, resolveStaging, settleParked, slugify, staging, swap, sweepGuard } from './internals.ts';

const INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The toasts the plugin has queued but not yet handed over, keyed by the handle it got back. */
interface PendingToast {
	after: number;
	callback: () => void;
}

const scratch = mkdtempSync(join(tmpdir(), 'skilld-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/*
 * The host resolves the plugins lock through its own directory layout, so the tests point that layout at the scratch to stay off the real `~/.omp`.
 * XDG is a Linux and macOS convention as far as the host is concerned — Windows ignores the variables outright — so the redirect there is `PI_CODING_AGENT_DIR`, which every platform honours.
 * The resolver freezes its environment when `pi-utils` loads, hence the rebuild once the variables are in place — and `$XDG_DATA_HOME/omp` has to exist for the XDG redirect to engage, the same bar `omp config init-xdg` sets.
 */
if (process.platform === 'win32') {
	process.env.PI_CODING_AGENT_DIR = join(scratch, 'omp');
} else {
	process.env.XDG_DATA_HOME = join(scratch, 'xdg');
	delete process.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(scratch, 'xdg', 'omp'), { recursive: true });
}

refreshDirsFromEnv();

/** The lock omp itself would read and write, asked for rather than assumed: which layout is in force is the host's business and differs by platform. */
const lockFile = getPluginsLockfile();

/** Writes this plugin's settings into the lock the way omp persists them. */
const writeLock = (settings: unknown) => {
	mkdirSync(dirname(lockFile), { recursive: true });
	writeFileSync(lockFile, JSON.stringify({ settings: { [PLUGIN_NAME]: settings } }));
};

interface HeardToast {
	message: string;
	type: string;
}

interface SessionStartHandler {
	(event: unknown, ctx: ExtensionContext): void | Promise<void>;
}

/** The pins standing in the stub's UI, keyed the way the plugin keys them: `undefined` is a pin taken down, which is a different thing from one never put up. */
interface Board {
	widgets: Record<string, string[] | undefined>;
	statuses: Record<string, string | undefined>;
}

/** The slivers of {@link ExtensionAPI} and {@link ExtensionContext} the plugin actually reaches for. The rest cannot be stood up, hence the casts. */
const listener = () => {
	const heard: HeardToast[] = [];
	const board: Board = { widgets: {}, statuses: {} };

	let onSessionStart: SessionStartHandler | undefined;
	let onTurnStart: (() => void) | undefined;

	const piStub = {
		on: (event: string, handler: SessionStartHandler) => {
			if (event === 'session_start') {
				onSessionStart = handler;
			}

			if (event === 'turn_start') {
				onTurnStart = handler as unknown as () => void;
			}
		},
		pi: { settings: { getAgentDir: () => join(scratch, 'agent') } }
	} as unknown as ExtensionAPI;

	/*
	 * Toasts go straight to `ctx.ui.notify` and land in `heard` as they happen; only the "in the background" announcement sits behind `ctx.setTimeout`.
	 * The queue is the plugin's, not the clock's, so the tests drain it instead of waiting `ANNOUNCEMENT_DELAY_MS` out in real time.
	 */
	const pending = new Map<object, PendingToast>();

	const ctxStub = {
		ui: {
			notify: (message: string, type: 'info' | 'warning' | 'error' = 'info') => {
				heard.push({ message, type });
			},
			/** Colour belongs to whatever theme is loaded and is nothing a test can assert on, so the stub hands the text straight back and lets the glyphs speak for the state. */
			theme: {
				fg: (_colour: string, text: string) => text,
				bold: (text: string) => text
			},
			setWidget: (key: string, content: string[] | undefined) => {
				board.widgets[key] = content;
			},
			setStatus: (key: string, text: string | undefined) => {
				board.statuses[key] = text;
			}
		},
		hasUI: true,
		cwd: scratch,
		setTimeout: (callback: () => void, after = 0) => {
			// The handle is its own key: omp hands one back and takes the same one in `clearTimer`, so nothing ever has to be read off it.
			const handle = { unref: () => undefined };

			pending.set(handle, { after, callback });

			return handle as unknown as Timer;
		},
		clearTimer: (timer: Timer) => {
			pending.delete(timer);
		}
	} as unknown as ExtensionContext;

	/** Hands over every queued toast, soonest first, including any queued by the ones already handed over. */
	const flush = () => {
		// A toast queued by a toast is the only nesting there is, so two rounds is one more than it takes; the bound is what keeps a mistake from spinning here.
		for (let round = 0; round < 4 && pending.size > 0; round += 1) {
			const due = [...pending.entries()].sort(([, one], [, other]) => one.after - other.after);

			pending.clear();

			for (const [, { callback }] of due) {
				callback();
			}
		}
	};

	/** Waits for a real, detached download to reach `condition`, flushing whatever toasts it queues along the way. Nothing here is on the plugin's clock — the downloads in these tests finish in milliseconds. */
	const settleDownload = async (condition: () => boolean) => {
		for (let waited = 0; waited < 5000; waited += 25) {
			flush();

			if (condition()) {
				return;
			}

			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	};

	/** Writes the settings the way omp persists them, runs one sweep, and hands over whatever it had to say. */
	const run = async (settings: unknown) => {
		writeLock(settings);

		sweepGuard.done = false;

		plugin(piStub);

		await onSessionStart?.({}, ctxStub);

		// The launch never waits on the sweep, but a test asserting on its outcome has to; the guard holds the promise for exactly this.
		await sweepGuard.settled;

		flush();
	};

	/** `turn` is the user getting back to work, which is omp's cue for the plugin to take its settled pins down. */
	return { heard, board, run, settleDownload, turn: () => onTurnStart?.() };
};

/**
 * The cases that plant a fake `gh` and let the real code spawn it.
 * The fake is a `#!/bin/sh` script on a scratch `PATH`, which Windows has no way to execute — and production does not go through a shell there either, so what these cover is the POSIX path by definition rather than by accident.
 */
const onPosix = test.skipIf(process.platform === 'win32');

/**
 * Plants a directory link of the kind production plants, which on Windows is a junction rather than a symlink.
 * A test that hands the real code a link to read has to hand it the same kind it makes, or the ownership check never meets the `\\?\` spelling a junction reads back as — which is the one thing about links that is Windows' own.
 */
const linkDir = (to: string, at: string) => {
	let kind: 'junction' | 'dir';

	if (process.platform === 'win32') {
		kind = 'junction';
	} else {
		kind = 'dir';
	}

	symlinkSync(to, at, kind);
};

/**
 * Runs one real refresh against a fake `gh` planted on `PATH`, so the spawn, the exit handling and the install run exactly as production wires them.
 * `PATH` holds the fake bin and nothing else — a machine's real `gh` must stay unreachable, or these tests would hit the network — so the wrapper's `sh` resolves through a link planted beside the fake, and the fake script re-arms its own `PATH` for the tools it calls.
 */
const refreshWith = async (name: string, gh?: string) => {
	const home = join(scratch, name);
	const bin = join(home, 'bin');
	const target = join(home, 'target');
	const stamp = join(home, 'stamp');

	mkdirSync(bin, { recursive: true });
	symlinkSync('/bin/sh', join(bin, 'sh'));

	if (gh !== undefined) {
		writeFileSync(join(bin, 'gh'), `#!/bin/sh\nPATH=/bin:/usr/bin\n${gh}`);
		chmodSync(join(bin, 'gh'), 0o755);
	}

	const previousPath = process.env.PATH;
	process.env.PATH = bin;

	const { heard, board, run, settleDownload, turn } = listener();

	try {
		await run({ sources: [{ repo: 'someone/their-skills', target, stamp, label: name }] });
	} finally {
		process.env.PATH = previousPath;
	}

	return { heard, board, settleDownload, turn, target, stamp };
};

test(
	'the module hands omp a factory as its default export, which is the whole contract the loader checks',
	() => {
		// `getExtensionFactory` takes `module.default` and rejects the extension outright when it is not callable.
		expect(typeof pluginModule.default)
			.toBe('function');
	}
);

test(
	'slugify replaces the separator so a repo can name a directory',
	() => expect(slugify('anthropics/skills')).toBe('anthropics-skills')
);

test(
	'slugify leaves a name with nothing to replace alone',
	() => expect(slugify('skills')).toBe('skills')
);

test(
	'expand turns a leading tilde into a real path, since nothing here goes through a shell',
	() => {
		expect(expand('~/skills'))
			.toBe(`${homedir()}/skills`);

		expect(expand('~'))
			.toBe(homedir());
	}
);

test(
	'expand leaves a path alone when the tilde is not the whole first segment',
	() => {
		expect(expand('/opt/~/skills'))
			.toBe('/opt/~/skills');

		expect(expand('~user/skills'))
			.toBe('~user/skills');
	}
);

test(
	'asInterval defaults only when nothing was configured',
	() => {
		expect(asInterval(undefined))
			.toBe(DEFAULT_INTERVAL_MS);

		expect(asInterval(3_600_000))
			.toBe(3_600_000);
	}
);

test(
	'asInterval refuses whatever is not a finite number of milliseconds',
	() => {
		expect(asInterval('daily'))
			.toBeUndefined();

		expect(asInterval(Number.NaN))
			.toBeUndefined();

		expect(asInterval(Number.POSITIVE_INFINITY))
			.toBeUndefined();

		// The manifest says `min: 0`, and nothing enforces the manifest; below zero would mean refresh-every-launch, which nobody asks for by accident twice.
		expect(asInterval(-1))
			.toBeUndefined();
	}
);

test(
	'asPlaceholder defaults only when nothing was configured',
	() => {
		expect(asPlaceholder(undefined))
			.toBe('template');

		expect(asPlaceholder('example'))
			.toBe('example');

		expect(asPlaceholder(false))
			.toBe(false);
	}
);

test(
	'asPlaceholder refuses anything that would point rmSync at the target itself',
	() => {
		expect(asPlaceholder(''))
			.toBe(false);

		expect(asPlaceholder('.'))
			.toBe(false);
	}
);

test(
	'asPlaceholder refuses anything that would point rmSync outside the target',
	() => {
		expect(asPlaceholder('..'))
			.toBe(false);

		expect(asPlaceholder('../../skills'))
			.toBe(false);

		expect(asPlaceholder('nested/template'))
			.toBe(false);

		expect(asPlaceholder('nested\\template'))
			.toBe(false);
	}
);

test(
	'isSource accepts the two documented shapes',
	() => {
		expect(isSource('anthropics/skills'))
			.toBe(true);

		expect(isSource({ repo: 'anthropics/skills' }))
			.toBe(true);

		expect(isSource({ repo: 'anthropics/skills', target: '~/skills', stamp: '~/stamp', label: 'the skills', placeholder: false }))
			.toBe(true);
	}
);

test(
	'isSource rejects whatever else a hand-written config file might hold',
	() => {
		expect(isSource(''))
			.toBe(false);

		expect(isSource({ target: '/skills' }))
			.toBe(false);

		expect(isSource({ repo: '' }))
			.toBe(false);

		expect(isSource({ repo: 42 }))
			.toBe(false);

		expect(isSource(null))
			.toBe(false);

		expect(isSource(undefined))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', target: 123 }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', stamp: true }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', label: {} }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', placeholder: 123 }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', target: '' }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', stamp: '' }))
			.toBe(false);
	}
);

test(
	'layout keeps downloads beside the agent directory and publishes into the skills directory omp scans itself',
	() => {
		expect(layout(join(homedir(), '.omp', 'agent')))
			.toEqual({ root: join(homedir(), '.omp', 'skilld'), linkRoot: join(homedir(), '.omp', 'agent', 'skills') });

		// Spelled with `join` rather than as a literal, because a separator is the platform's to choose and this asserts on where the paths land, not on how they are punctuated.
		expect(layout(join('/xdg', 'omp', 'agent')))
			.toEqual({ root: join('/xdg', 'omp', 'skilld'), linkRoot: join('/xdg', 'omp', 'agent', 'skills') });
	}
);

/** A downloaded target as `gh` leaves it: one directory per skill, each with the `SKILL.md` that makes it one. */
const downloaded = (name: string, skills: string[]) => {
	const target = join(scratch, name, 'target');
	const linkRoot = join(scratch, name, 'skills');

	for (const skill of skills) {
		mkdirSync(join(target, skill), { recursive: true });
		writeFileSync(join(target, skill, 'SKILL.md'), '');
	}

	return { target, linkRoot };
};

test(
	'linkSkills publishes every downloaded skill, and only the ones that are skills',
	() => {
		const { target, linkRoot } = downloaded('link-fresh', ['pdf', 'docx']);

		mkdirSync(join(target, 'not-a-skill'), { recursive: true });

		expect(linkSkills(target, linkRoot).linked.sort())
			.toEqual(['docx', 'pdf']);

		expect(readlinkSync(join(linkRoot, 'pdf')))
			.toBe(join(target, 'pdf'));

		expect(existsSync(join(linkRoot, 'not-a-skill')))
			.toBe(false);
	}
);

test(
	'linkSkills is idempotent, so a second launch relinks nothing',
	() => {
		const { target, linkRoot } = downloaded('link-again', ['pdf']);

		linkSkills(target, linkRoot);

		expect(linkSkills(target, linkRoot))
			.toEqual({ skills: ['pdf'], linked: [], refused: [] });
	}
);

test(
	'linkSkills refuses a name the user already holds, whether their own skill or a link of their own',
	() => {
		const { target, linkRoot } = downloaded('link-taken', ['pdf', 'docx']);
		const mine = join(scratch, 'link-taken', 'mine');

		mkdirSync(join(linkRoot, 'pdf'), { recursive: true });
		mkdirSync(mine, { recursive: true });
		linkDir(mine, join(linkRoot, 'docx'));

		const { linked, refused } = linkSkills(target, linkRoot);

		expect(linked)
			.toEqual([]);

		// Sorted: what the directory hands back is in whatever order the filesystem keeps, not the order the download was written in.
		expect(refused.sort())
			.toEqual(['docx', 'pdf']);

		expect(readlinkSync(join(linkRoot, 'docx')))
			.toBe(mine);
	}
);

test(
	'linkSkills sweeps its own link once the skill behind it is gone, and leaves the user everything else',
	() => {
		const { target, linkRoot } = downloaded('link-stale', ['pdf', 'dropped']);
		const theirs = join(scratch, 'link-stale', 'theirs');

		linkSkills(target, linkRoot);
		mkdirSync(theirs, { recursive: true });
		linkDir(theirs, join(linkRoot, 'kept'));
		rmSync(join(target, 'dropped'), { recursive: true, force: true });

		expect(linkSkills(target, linkRoot))
			.toEqual({ skills: ['pdf'], linked: [], refused: [] });

		// The listing, rather than `existsSync`, because a link left dangling would read as absent while still sitting there.
		expect(readdirSync(linkRoot).sort())
			.toEqual(['kept', 'pdf']);

		expect(readlinkSync(join(linkRoot, 'kept')))
			.toBe(theirs);
	}
);

test(
	'normalize derives every path from a bare repo string',
	() => {
		const source = normalize('anthropics/skills', '/omp/skilld');

		// `normalize` resolves what it derives, so the expectation resolves too: on Windows that is what puts a drive letter in front of a rooted path.
		expect(source).toEqual({
			repo: 'anthropics/skills',
			target: resolve('/omp/skilld/anthropics-skills'),
			stamp: resolve('/omp/skilld/.anthropics-skills-refreshed'),
			label: 'anthropics/skills',
			placeholder: 'template'
		});
	}
);

test(
	'a fresh target republishes a deleted link on the next launch without downloading again',
	async () => {
		const target = join(scratch, 'self-heal', 'target');
		const stamp = join(scratch, 'self-heal', 'stamp');
		const linkRoot = join(scratch, 'agent', 'skills');

		mkdirSync(join(target, 'pdf'), { recursive: true });
		writeFileSync(join(target, 'pdf', 'SKILL.md'), '');
		writeFileSync(stamp, '');
		mkdirSync(linkRoot, { recursive: true });
		linkDir(join(target, 'pdf'), join(linkRoot, 'pdf'));

		// The user deleting a published link by hand, which is the thing this test is about — removed the way the plugin removes one, since a junction is not something `rm` can take.
		unlink(join(linkRoot, 'pdf'));

		const { run } = listener();
		await run({ sources: [{ repo: 'someone/their-skills', target, stamp }], interval: INTERVAL_MS });

		expect(readlinkSync(join(linkRoot, 'pdf')))
			.toBe(join(target, 'pdf'));
	}
);

test(
	'normalize hides the stamp outside the target, so what omp scans holds skills and nothing else',
	() => {
		const { target, stamp } = normalize('anthropics/skills', '/omp/skilld');

		expect(stamp.startsWith(`${target}/`))
			.toBe(false);

		expect(dirname(stamp))
			.toBe(dirname(target));
	}
);

test(
	'normalize fills the same defaults in for an object that only names a repo',
	() => expect(normalize({ repo: 'anthropics/skills' }, '/omp/skilld'))
		.toEqual(normalize('anthropics/skills', '/omp/skilld'))
);

test(
	'normalize honours every override',
	() => {
		const overridden = {
			repo: 'someone/their-skills',
			target: '/skills',
			stamp: '/state/stamp',
			label: 'their skills',
			placeholder: 'example'
		};

		expect(normalize(overridden, '/omp/skilld'))
			.toEqual({ ...overridden, target: resolve(overridden.target), stamp: resolve(overridden.stamp) });
	}
);

test(
	'normalize keeps `placeholder: false` rather than defaulting it, so nothing is deleted',
	() => expect(normalize({ repo: 'someone/their-skills', placeholder: false }, '/omp/skilld').placeholder)
		.toBe(false)
);

test(
	'normalize expands a tilde in the paths it was handed',
	() => {
		const source = normalize({ repo: 'someone/their-skills', target: '~/skills', stamp: '~/state/stamp' }, '/omp/skilld');

		expect(source.target)
			.toBe(join(homedir(), 'skills'));

		expect(source.stamp)
			.toBe(join(homedir(), 'state', 'stamp'));
	}
);

test(
	'normalize drops a placeholder that would have deleted the whole target',
	() => expect(normalize({ repo: 'someone/their-skills', placeholder: '' }, '/omp/skilld').placeholder)
		.toBe(false)
);

test(
	'normalize straightens what a hand-written path drags in, so every later comparison sees one spelling',
	() => {
		const source = normalize({ repo: 'someone/their-skills', target: '/skills/anthropic/', stamp: '/state/./anthropic-stamp' }, '/omp/skilld');

		expect(source.target)
			.toBe(resolve('/skills/anthropic'));

		expect(source.stamp)
			.toBe(resolve('/state/anthropic-stamp'));
	}
);

test(
	'linkSkills stays idempotent under a target spelled with a trailing slash',
	() => {
		const { target, linkRoot } = downloaded('link-trailing-slash', ['pdf']);

		expect(linkSkills(`${target}/`, linkRoot).linked)
			.toEqual(['pdf']);

		// The second launch has to recognise its own link, not refuse it as the user's.
		expect(linkSkills(`${target}/`, linkRoot))
			.toEqual({ skills: ['pdf'], linked: [], refused: [] });
	}
);

test(
	'staging hides both directories beside the target, so a scan ignores them and the swap stays a rename',
	() => expect(staging('/skills/anthropic'))
		.toEqual({ incoming: '/skills/.anthropic.incoming', outgoing: '/skills/.anthropic.outgoing', done: '/skills/.anthropic.done', failed: '/skills/.anthropic.failed', pid: '/skills/.anthropic.pid', noise: '/skills/.anthropic.stderr' })
);

/** Plants what a download left on `gh`'s stderr, and hands back the path the plugin reads it from. */
const grumbled = (name: string, said: string) => {
	const { noise } = staging(join(scratch, name));

	writeFileSync(noise, said);

	return noise;
};

test(
	'a download that failed without a word leaves the exit code to speak alone, rather than trailing it with an empty quote',
	() => expect(complaint(grumbled('quiet-failure', '\n   \n')))
		.toBeUndefined()
);

test(
	'a download that never wrote a stderr file at all is the same silence, not a failure to read one',
	() => expect(complaint(join(scratch, 'never-grumbled.stderr')))
		.toBeUndefined()
);

test(
	'a complaint is the end of what was said rather than the start, since a download prints its progress on the same stream and the reason it stopped comes last',
	() => expect(complaint(grumbled('noisy-failure', 'Fetching skills\nResolving anthropics/skills\ncannot install skills with conflicting names:\n  pdf (anthropics/skills)\n  pdf (someone/theirs)\n')))
		.toBe('cannot install skills with conflicting names: · pdf (anthropics/skills) · pdf (someone/theirs)')
);

test(
	'a spinner writes over itself with carriage returns, which break a line the same way, or a whole download would arrive as one',
	() => expect(complaint(grumbled('spinner-failure', 'fetching\rdownloading 1%\rdownloading 99%\rerror: HTTP 401\n')))
		.toBe('downloading 1% · downloading 99% · error: HTTP 401')
);

test(
	'a download that failed at length is cut to what a pin can hold, since a stack trace under the editor is worse than no reason at all',
	() => {
		const said = complaint(grumbled('verbose-failure', `${'chatter '.repeat(200)}\n`));

		expect(said?.length)
			.toBeLessThan(300);

		expect(said)
			.toStartWith('…');
	}
);

test(
	'a complaint too long to fit is cut at the front, since `gh` prints its hint before the reason and it is the reason that has to survive the cut',
	() => {
		// What `gh` 2.97 really answers when two skills in one repository share a name: the hint comes first, and its absolute path is long enough to spend the whole budget on its own.
		const said = complaint(grumbled(
			'collision-failure',
			`Hint: install individually using the full name: gh skill install ${'/a-rather-long-path-segment'.repeat(8)} namespace/skill-name\ncannot install skills with conflicting names; they would overwrite each other:\n  pdf: engineering/pdf, writing/pdf\n`
		));

		expect(said)
			.toEndWith('cannot install skills with conflicting names; they would overwrite each other: · pdf: engineering/pdf, writing/pdf');

		expect(said)
			.toStartWith('…');
	}
);

/** A staging area as an earlier launch would have left it: the download, plus whatever marker recorded how it ended. */
const staged = (name: string, marker?: 'done' | 'failed', age = 0) => {
	const target = join(scratch, name);
	const { incoming, done, failed, pid } = staging(target);

	mkdirSync(join(incoming, 'a-skill'), { recursive: true });

	if (marker === 'done') {
		writeFileSync(done, '');
	}

	if (marker === 'failed') {
		writeFileSync(failed, '');
	}

	if (age > 0) {
		const when = new Date(Date.now() - age);

		// "Nothing has touched the download" means nothing anywhere in it, so the skill directory ages with its root.
		utimesSync(incoming, when, when);
		utimesSync(join(incoming, 'a-skill'), when, when);

		if (marker === 'done') {
			utimesSync(done, when, when);
		} else if (marker !== undefined) {
			utimesSync(failed, when, when);
		}
	}

	return { target, incoming, done, failed, pid };
};

test(
	'resolveStaging stands in a download that finished after the launch which started it died',
	() => {
		const { target, incoming } = staged('resolve-done', 'done');

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('finish');

		// Left for the caller to install: deciding is not the same as swapping.
		expect(existsSync(incoming))
			.toBe(true);
	}
);

test(
	'resolveStaging sweeps a download whose refresh has already been recorded, the marker and the download together',
	() => {
		const { target, incoming, done } = staged('resolve-done-fresh', 'done');

		const stamp = join(scratch, 'resolve-done-fresh-stamp');
		writeFileSync(stamp, '');

		expect(resolveStaging(target, stamp, INTERVAL_MS))
			.toBe('skip');

		expect(existsSync(done))
			.toBe(false);

		// Left behind, the download would read as still running to the next stale launch and stall it, when nothing can ever install it.
		expect(existsSync(incoming))
			.toBe(false);
	}
);

test(
	'resolveStaging holds off after a failure, so a launch loop cannot spend the rate limit an attempt at a time',
	() => {
		const { target, incoming, failed } = staged('resolve-failed-recent', 'failed');

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('cooling');

		// Both are the record of that failure: sweeping either would forget it and try again next launch.
		expect(existsSync(failed))
			.toBe(true);

		expect(existsSync(incoming))
			.toBe(true);
	}
);

test(
	'resolveStaging sweeps a failure old enough to be worth another attempt',
	() => {
		const { target, incoming, failed } = staged('resolve-failed', 'failed', FAILURE_COOLDOWN_MS + 60_000);

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('failed');

		expect(existsSync(incoming))
			.toBe(false);

		expect(existsSync(failed))
			.toBe(false);
	}
);

test(
	'resolveStaging leaves a download that is still running alone, however short the interval',
	() => {
		const { target, incoming } = staged('resolve-running');

		// Zero interval: every launch counts as due. The download still owns its directory.
		expect(resolveStaging(target, join(scratch, 'never-refreshed'), 0))
			.toBe('in-flight');

		expect(existsSync(incoming))
			.toBe(true);
	}
);

test(
	'resolveStaging sweeps a download nothing has touched since long before a download could take',
	() => {
		const { target, incoming } = staged('resolve-abandoned', undefined, ABANDONED_MS + 60_000);

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('skip');

		expect(existsSync(incoming))
			.toBe(false);
	}
);

test(
	'resolveStaging trusts a live process over a quiet directory, so a slow download is never swept mid-run',
	() => {
		const { target, incoming, pid } = staged('resolve-quiet-alive', undefined, ABANDONED_MS + 60_000);

		// The test's own process stands in for a download that has gone quiet — one long file writes nothing new into the directory for as long as it takes.
		writeFileSync(pid, String(process.pid));

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('in-flight');

		expect(existsSync(incoming))
			.toBe(true);
	}
);

test(
	'resolveStaging sweeps a download whose process is gone without waiting out the clock',
	() => {
		const { target, incoming, pid } = staged('resolve-dead');

		// A process that has already exited: hard-killed mid-download, its directory still fresh. The runtime running this suite is the one executable every platform is guaranteed to have.
		const gone = spawnSync(process.execPath, ['-e', '']).pid;
		writeFileSync(pid, String(gone));

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('skip');

		expect(existsSync(incoming))
			.toBe(false);

		expect(existsSync(pid))
			.toBe(false);
	}
);

test(
	'resolveStaging reads liveness from the whole download, since only new entries bump a directory',
	() => {
		const { target, incoming } = staged('resolve-deep-write', undefined, ABANDONED_MS + 60_000);

		// The root went quiet once every skill directory existed, but a skill is still filling up; creating it bumped the root, so the root is aged again.
		mkdirSync(join(incoming, 'busy-skill'), { recursive: true });

		const quiet = new Date(Date.now() - ABANDONED_MS - 60_000);
		utimesSync(incoming, quiet, quiet);

		expect(resolveStaging(target, join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe('in-flight');

		expect(existsSync(incoming))
			.toBe(true);
	}
);

/**
 * Runs the real wrapper with a `PATH` holding only what the case wants `gh` to be, so the markers are the shell's own doing and no `gh` installed on this machine can be reached.
 * Nothing else the command needs — `[`, `:`, the redirection — lives outside the shell, which is what makes that `PATH` enough; the shell itself is spawned by absolute path, since Node resolves the executable through the same `PATH` the case has emptied.
 */
const runInstall = (name: string, gh?: { script: string; mode: number }) => {
	const home = join(scratch, name);
	const bin = join(home, 'bin');
	const { incoming, done, failed, noise } = staging(join(home, 'target'));

	mkdirSync(bin, { recursive: true });

	if (gh !== undefined) {
		const path = join(bin, 'gh');

		writeFileSync(path, gh.script);
		chmodSync(path, gh.mode);
	}

	const { status, error } = spawnSync('/bin/sh', ['-c', installCommand('anthropics/skills', incoming, done, failed, noise)], { env: { PATH: bin }, stdio: 'ignore' });

	if (error !== undefined) {
		throw error;
	}

	// A null status is the shell itself having been killed, which is not a verdict any case here is waiting on — and saying so leaves every caller a plain number to assert against.
	if (status === null) {
		throw new Error('`sh` was killed before it could reach a verdict');
	}

	return { status, done: existsSync(done), failed: existsSync(failed) };
};

onPosix(
	'a `gh` that cannot be found leaves no marker, so a cooldown it never earned is not armed',
	() => {
		expect(runInstall('gh-missing'))
			.toEqual({ status: NOT_FOUND, done: false, failed: false });
	}
);

onPosix(
	'a `gh` that cannot be executed leaves no marker either',
	() => {
		const { status, ...markers } = runInstall('gh-unrunnable', { script: '#!/bin/sh\nexit 0\n', mode: 0o644 });

		/*
		 * Which of the two verdicts a `gh` it cannot run earns is the shell's own business, and they disagree: 126 where the search stops at the file, 127 where it goes on looking and ends up with nothing.
		 * The plugin exempts both from the failure marker for exactly that reason, so pinning one of them here would only test which `/bin/sh` the suite happens to be running on.
		 */
		expect([NOT_EXECUTABLE, NOT_FOUND])
			.toContain(status);

		expect(markers)
			.toEqual({ done: false, failed: false });
	}
);

onPosix(
	'a `gh` that ran and failed leaves the failure marker the cooldown reads',
	() => {
		expect(runInstall('gh-failed', { script: '#!/bin/sh\nexit 1\n', mode: 0o755 }))
			.toEqual({ status: 1, done: false, failed: true });
	}
);

onPosix(
	'a `gh` that succeeded leaves the completion marker a later launch installs from',
	() => {
		expect(runInstall('gh-succeeded', { script: '#!/bin/sh\nexit 0\n', mode: 0o755 }))
			.toEqual({ status: 0, done: true, failed: false });
	}
);

onPosix(
	'a refresh downloads, installs, stamps and publishes end to end',
	async () => {
		const { heard, settleDownload, target, stamp } = await refreshWith(
			'e2e-success',
			'mkdir -p "$6/e2e-success-skill"\necho done > "$6/e2e-success-skill/SKILL.md"\nexit 0\n'
		);

		await settleDownload(() => existsSync(stamp));

		expect(existsSync(join(target, 'e2e-success-skill', 'SKILL.md')))
			.toBe(true);

		// Published into the directory omp scans, and the staging area is spent.
		expect(readlinkSync(join(scratch, 'agent', 'skills', 'e2e-success-skill')))
			.toBe(join(target, 'e2e-success-skill'));

		expect(existsSync(staging(target).done))
			.toBe(false);

		expect(existsSync(staging(target).incoming))
			.toBe(false);

		expect(heard.some((toast) => toast.type === 'info' && toast.message.includes('ready')))
			.toBe(true);
	}
);

onPosix(
	'a refresh whose download fails records the failure and keeps the cooldown armed',
	async () => {
		const { heard, settleDownload, target, stamp } = await refreshWith(
			'e2e-failure',
			'exit 1\n'
		);

		await settleDownload(() => existsSync(staging(target).failed));

		expect(heard.some((toast) => toast.type === 'error' && toast.message.includes('exited with code 1')))
			.toBe(true);

		// Nothing to install means nothing to stand in: the target never appears, and no stamp records a refresh that did not happen.
		expect(existsSync(target))
			.toBe(false);

		expect(existsSync(stamp))
			.toBe(false);
	}
);

onPosix(
	'a refresh whose `gh` said why it failed repeats what it said, since an exit code on its own is not a reason',
	async () => {
		const { heard, board, settleDownload } = await refreshWith(
			'e2e-complaint',
			'echo "cannot install skills with conflicting names: pdf" >&2\nexit 1\n'
		);

		// The failure marker is the wrapper's doing and lands before the exit handler speaks; what this case is waiting on is the speaking.
		await settleDownload(() => heard.some((toast) => toast.type === 'error'));

		expect(heard.some((toast) => toast.type === 'error' && toast.message.includes('conflicting names: pdf')))
			.toBe(true);

		expect(board.widgets[`${PLUGIN_NAME}:e2e-complaint`]?.join('\n'))
			.toContain('conflicting names: pdf');
	}
);

onPosix(
	'a refresh that succeeded takes the grumbling with it, since a complaint left lying beside a working install is one a later failure would repeat as its own',
	async () => {
		// `gh` warns and installs anyway, which is the case that leaves a complaint behind a success.
		const { settleDownload, target, stamp } = await refreshWith(
			'e2e-grumbled-success',
			'echo "warning: skill `pdf` was already up to date" >&2\nmkdir -p "$6/grumbled-skill"\necho done > "$6/grumbled-skill/SKILL.md"\nexit 0\n'
		);

		await settleDownload(() => existsSync(stamp));

		expect(existsSync(staging(target).noise))
			.toBe(false);
	}
);

onPosix(
	'a refresh with no `gh` to run says so, and arms no cooldown it never earned',
	async () => {
		const { heard, settleDownload, target } = await refreshWith('e2e-no-gh');

		await settleDownload(() => heard.some((toast) => toast.type === 'error'));

		expect(heard.some((toast) => toast.message.includes('`gh` is not installed')))
			.toBe(true);

		expect(existsSync(staging(target).failed))
			.toBe(false);
	}
);

onPosix(
	'a finished refresh pins what it did where a toast cannot scroll away from it, counting only the skills omp will see',
	async () => {
		const { board, settleDownload, stamp } = await refreshWith(
			'pin-success',
			'mkdir -p "$6/one" "$6/two"\necho done > "$6/one/SKILL.md"\necho done > "$6/two/SKILL.md"\nexit 0\n'
		);

		await settleDownload(() => existsSync(stamp));

		expect(board.widgets[`${PLUGIN_NAME}:pin-success`]?.join('\n'))
			.toMatch(/✓ skilld · 2 skill\(s\) ready · restart omp/);

		// The status bar has room for the count and nothing else, which is the part worth having there.
		expect(board.statuses[`${PLUGIN_NAME}:pin-success`])
			.toBe('✓ 2 skills');
	}
);

onPosix(
	'a refresh that fails pins why, since a failure the user never saw is the one that looks like the plugin doing nothing',
	async () => {
		const { board, settleDownload, target } = await refreshWith('pin-failure', 'exit 1\n');

		await settleDownload(() => existsSync(staging(target).failed));

		expect(board.widgets[`${PLUGIN_NAME}:pin-failure`]?.join('\n'))
			.toMatch(/✗ skilld · could not refresh pin-failure: `gh` exited with code 1/);

		expect(board.statuses[`${PLUGIN_NAME}:pin-failure`])
			.toBe('✗ refresh failed');
	}
);

onPosix(
	'a settled pin comes down when the user gets back to work, which is what starting a turn says',
	async () => {
		const { board, settleDownload, turn, stamp } = await refreshWith(
			'pin-release',
			'mkdir -p "$6/one"\necho done > "$6/one/SKILL.md"\nexit 0\n'
		);

		await settleDownload(() => existsSync(stamp));

		turn();

		expect(board.widgets[`${PLUGIN_NAME}:pin-release`])
			.toBeUndefined();

		expect(board.statuses[`${PLUGIN_NAME}:pin-release`])
			.toBeUndefined();
	}
);

onPosix(
	'a download still running keeps its pin through a turn, since a thing in progress is not news to be dismissed',
	async () => {
		// Long enough that the download cannot settle within the test, so what is asserted is the pin of a refresh that is genuinely still running.
		const { board, turn } = await refreshWith('pin-working', 'sleep 30\nexit 0\n');

		expect(board.widgets[`${PLUGIN_NAME}:pin-working`]?.join('\n'))
			.toMatch(/⟳ skilld · fetching pin-working from GitHub/);

		turn();

		expect(board.widgets[`${PLUGIN_NAME}:pin-working`]?.join('\n'))
			.toMatch(/⟳ skilld/);

		expect(board.statuses[`${PLUGIN_NAME}:pin-working`])
			.toBe('⟳ skills');
	}
);

test(
	'asSources takes the bare list most configurations are, since the CLI can only store text',
	() => {
		expect(asSources('anthropics/skills'))
			.toEqual(['anthropics/skills']);

		expect(asSources('anthropics/skills, someone/their-skills'))
			.toEqual(['anthropics/skills', 'someone/their-skills']);

		expect(asSources(' anthropics/skills\nsomeone/their-skills '))
			.toEqual(['anthropics/skills', 'someone/their-skills']);
	}
);

test(
	'asSources still reads the JSON a per-source override needs, as a list or a single object',
	() => {
		expect(asSources('[{"repo":"anthropics/skills","label":"skills"}]'))
			.toEqual([{ repo: 'anthropics/skills', label: 'skills' }]);

		expect(asSources('{"repo":"anthropics/skills"}'))
			.toEqual([{ repo: 'anthropics/skills' }]);
	}
);

test(
	'asSources passes an array through and refuses what is neither a list nor text',
	() => {
		const configured = [{ repo: 'anthropics/skills' }];

		expect(asSources(configured))
			.toBe(configured);

		expect(asSources(''))
			.toEqual([]);

		expect(asSources(42))
			.toBeUndefined();

		expect(asSources('[{"repo":'))
			.toBeUndefined();
	}
);

test(
	'isRepo accepts an `owner/repo` and refuses what `gh` would only fail on',
	() => {
		expect(['anthropics/skills', 'some-one/their_skills.v2'].every(isRepo))
			.toBe(true);

		expect(['', 'skills', 'anthropics/', '/skills', 'anthropics/skills/extra', 'not a repo', 'anthropics/skills;rm -rf /'].some(isRepo))
			.toBe(false);
	}
);

test(
	'dropPlaceholder deletes the placeholder skill a template repository ships',
	() => {
		const incoming = join(scratch, 'placeholder-download');
		mkdirSync(join(incoming, 'template'), { recursive: true });
		writeFileSync(join(incoming, 'template', 'SKILL.md'), '---\nname: template\ndescription: Replace with description of the skill and when Claude should use it.\n---\n');

		expect(dropPlaceholder(incoming, 'template'))
			.toBe(true);

		expect(existsSync(join(incoming, 'template')))
			.toBe(false);
	}
);

test(
	'dropPlaceholder keeps a real skill that merely goes by the placeholder name',
	() => {
		const incoming = join(scratch, 'real-template-skill');
		mkdirSync(join(incoming, 'template'), { recursive: true });
		writeFileSync(join(incoming, 'template', 'SKILL.md'), '---\nname: template\ndescription: Scaffolds a new service from the house template.\n---\n');

		expect(dropPlaceholder(incoming, 'template'))
			.toBe(false);

		expect(existsSync(join(incoming, 'template')))
			.toBe(true);
	}
);

test(
	'dropPlaceholder keeps a skill that merely quotes the template phrase in its body',
	() => {
		const incoming = join(scratch, 'quoting-placeholder');
		mkdirSync(join(incoming, 'template'), { recursive: true });

		// Only what the skill says about itself counts; what it says about the template does not.
		writeFileSync(join(incoming, 'template', 'SKILL.md'), '---\nname: template\ndescription: Authoring guide for new skills.\n---\nDelete the template description: "Replace with description of the skill and when Claude should use it."\n');

		expect(dropPlaceholder(incoming, 'template'))
			.toBe(false);

		expect(existsSync(join(incoming, 'template')))
			.toBe(true);
	}
);

test(
	'dropPlaceholder leaves alone what it cannot recognise, and does nothing at all when turned off',
	() => {
		const incoming = join(scratch, 'unrecognisable-placeholder');
		mkdirSync(join(incoming, 'template', 'assets'), { recursive: true });

		// No `SKILL.md`, so nothing says what this is; a guess here deletes somebody's directory.
		expect(dropPlaceholder(incoming, 'template'))
			.toBe(false);

		expect(dropPlaceholder(incoming, false))
			.toBe(false);

		expect(existsSync(join(incoming, 'template', 'assets')))
			.toBe(true);
	}
);

test(
	'readPluginSettings reads the lock where omp keeps it, XDG layout included',
	async () => {
		writeLock({ sources: 'anthropics/skills', interval: 1 });

		const { options, error } = await readPluginSettings(join(scratch, 'xdg-lock-cwd'));

		expect(error).toBeUndefined();

		expect(options)
			.toEqual({ sources: 'anthropics/skills', interval: 1 });
	}
);

test(
	'readPluginSettings lets a project override the settings, from cwd as omp does',
	async () => {
		const project = join(scratch, 'override-project');
		mkdirSync(join(project, '.omp'), { recursive: true });

		writeLock({ sources: 'anthropics/skills', interval: 1 });
		writeFileSync(join(project, '.omp', 'plugin-overrides.json'), JSON.stringify({ settings: { [PLUGIN_NAME]: { sources: 'someone/their-skills' } } }));

		const { options, error } = await readPluginSettings(project);

		expect(error).toBeUndefined();

		// The project's `sources` wins; the interval it says nothing about is still the global one.
		expect(options)
			.toEqual({ sources: 'someone/their-skills', interval: 1 });
	}
);

test(
	'readPluginSettings does not walk ancestors for overrides, because omp reads them at cwd alone',
	async () => {
		const root = join(scratch, 'no-ancestor-walk');
		const deep = join(root, 'packages', 'thing');
		mkdirSync(join(root, '.omp'), { recursive: true });
		mkdirSync(deep, { recursive: true });

		writeLock({ sources: 'anthropics/skills' });

		// An override omp would never see must not apply here either: what refreshes has to match what `omp plugin config list` says.
		writeFileSync(join(root, '.omp', 'plugin-overrides.json'), JSON.stringify({ settings: { [PLUGIN_NAME]: { sources: 'someone/their-skills' } } }));

		const { options, error } = await readPluginSettings(deep);

		expect(error).toBeUndefined();

		expect(options)
			.toEqual({ sources: 'anthropics/skills' });
	}
);

test(
	'a project override that will not parse is skipped the way omp skips it, not read as an error',
	async () => {
		const project = join(scratch, 'override-malformed');
		mkdirSync(join(project, '.claude'), { recursive: true });

		writeLock({ sources: 'anthropics/skills' });

		// Another tool's half-saved file must not switch this plugin off: the lock still parses, and the lock is where the sources live.
		writeFileSync(join(project, '.claude', 'plugin-overrides.json'), '{ not json');

		const { options, error } = await readPluginSettings(project);

		expect(error).toBeUndefined();

		expect(options)
			.toEqual({ sources: 'anthropics/skills' });
	}
);

test(
	'a lock file that will not parse is still an error, so the user hears why nothing refreshes',
	async () => {
		mkdirSync(dirname(lockFile), { recursive: true });
		writeFileSync(lockFile, '{ not json');

		const { error } = await readPluginSettings(join(scratch, 'lock-malformed-cwd'));

		expect(error).toBeDefined();
	}
);

test(
	'settleParked stands the parked skills back in when a dead swap left no live directory',
	() => {
		const target = join(scratch, 'parked-restore');
		const { outgoing } = staging(target);

		// A launch killed between the swap's two renames: the previous skills sit in `outgoing`, and `target` is gone.
		mkdirSync(join(outgoing, 'precious-skill'), { recursive: true });

		expect(settleParked(target))
			.toBe(true);

		expect(existsSync(join(target, 'precious-skill')))
			.toBe(true);

		expect(existsSync(outgoing))
			.toBe(false);
	}
);

test(
	'settleParked discards the parked directory once a live one stands, since a finished swap has no more use for it',
	() => {
		const target = join(scratch, 'parked-discard');
		const { outgoing } = staging(target);

		mkdirSync(join(target, 'live-skill'), { recursive: true });
		mkdirSync(join(outgoing, 'stale-skill'), { recursive: true });

		expect(settleParked(target))
			.toBe(false);

		expect(existsSync(join(target, 'live-skill')))
			.toBe(true);

		expect(existsSync(outgoing))
			.toBe(false);
	}
);

test(
	'swap stands a finished download in for the live directory',
	() => {
		const target = join(scratch, 'swap-live');
		const { incoming, outgoing } = staging(target);

		mkdirSync(join(target, 'stale-skill'), { recursive: true });
		mkdirSync(join(incoming, 'fresh-skill'), { recursive: true });

		mkdirSync(join(outgoing, 'debris'), { recursive: true });

		swap(target);

		expect(existsSync(join(target, 'fresh-skill')))
			.toBe(true);

		expect(existsSync(join(target, 'stale-skill')))
			.toBe(false);

		expect(existsSync(incoming))
			.toBe(false);

		expect(existsSync(outgoing))
			.toBe(false);
	}
);

test(
	'swap installs a download when no live directory exists yet, as on a first refresh',
	() => {
		const target = join(scratch, 'swap-first-run');
		const { incoming } = staging(target);

		mkdirSync(join(incoming, 'fresh-skill'), { recursive: true });

		swap(target);

		expect(existsSync(join(target, 'fresh-skill')))
			.toBe(true);
	}
);

test(
	'swap puts the live directory back when there is nothing to stand in for it',
	() => {
		const target = join(scratch, 'swap-restore');
		mkdirSync(join(target, 'precious-skill'), { recursive: true });

		expect(() => swap(target))
			.toThrow();

		expect(existsSync(join(target, 'precious-skill')))
			.toBe(true);
	}
);

test(
	'swap leaves no target behind when a first refresh has nothing to stand in',
	() => {
		const target = join(scratch, 'swap-first-run-restore');

		expect(() => swap(target))
			.toThrow();

		expect(existsSync(target))
			.toBe(false);
	}
);

test(
	'swap shrugs off a parked directory that will not clear, since the install itself has already succeeded',
	() => {
		const target = join(scratch, 'swap-cleanup');
		const { incoming, outgoing } = staging(target);

		mkdirSync(join(target, 'stale-skill'), { recursive: true });
		writeFileSync(join(target, 'stale-skill', 'SKILL.md'), '');
		mkdirSync(join(incoming, 'fresh-skill'), { recursive: true });

		/*
		 * Stripping the write bit keeps the parked skill's contents from being unlinked, which fails the final cleanup and nothing else.
		 * Windows ignores the bit on directories and root ignores it everywhere, so there the cleanup simply succeeds — the assertions hold either way.
		 */
		chmodSync(join(target, 'stale-skill'), 0o555);

		try {
			expect(() => swap(target))
				.not.toThrow();

			expect(existsSync(join(target, 'fresh-skill')))
				.toBe(true);
		} finally {
			const parked = join(outgoing, 'stale-skill');

			if (existsSync(parked)) {
				chmodSync(parked, 0o755);
			}
		}
	}
);

test(
	'isStale is stale when there is no stamp at all',
	() => expect(isStale(join(scratch, 'never-refreshed'), INTERVAL_MS))
		.toBe(true)
);

test(
	'isStale is fresh when the stamp was just written',
	() => {
		const stamp = join(scratch, 'just-refreshed');
		writeFileSync(stamp, '');

		expect(isStale(stamp, INTERVAL_MS))
			.toBe(false);
	}
);

test(
	'isStale is stale once the stamp is older than the interval',
	() => {
		const stamp = join(scratch, 'refreshed-long-ago');
		writeFileSync(stamp, '');

		const wellPastTheInterval = new Date(Date.now() - 2 * INTERVAL_MS);
		utimesSync(stamp, wellPastTheInterval, wellPastTheInterval);

		expect(isStale(stamp, INTERVAL_MS))
			.toBe(true);
	}
);

test(
	'isEmpty is empty when the directory does not exist',
	() => expect(isEmpty(join(scratch, 'absent')))
		.toBe(true)
);

test(
	'isEmpty is empty when the directory exists with nothing in it',
	() => {
		const target = join(scratch, 'bare');
		mkdirSync(target, { recursive: true });

		expect(isEmpty(target))
			.toBe(true);
	}
);

test(
	'isEmpty is not empty once a skill has been installed',
	() => {
		const target = join(scratch, 'populated');
		mkdirSync(join(target, 'some-skill'), { recursive: true });

		expect(isEmpty(target))
			.toBe(false);
	}
);

test(
	'a download that could not be installed stays claimable, so the next launch retries the install instead of the download',
	async () => {
		const target = join(scratch, 'rearm', 'target');
		const stamp = join(scratch, 'rearm', 'stamp');
		const { incoming, done } = staging(target);

		mkdirSync(join(incoming, 'a-skill'), { recursive: true });
		writeFileSync(join(incoming, 'a-skill', 'SKILL.md'), '');
		writeFileSync(done, '');

		// A dangling link where the live directory should stand: `existsSync` reads it as absent, so the swap tries to stand the download straight in and the rename refuses.
		linkDir(join(scratch, 'rearm', 'nowhere'), target);

		const { heard, run } = listener();
		await run({ sources: [{ repo: 'someone/their-skills', target, stamp }] });

		expect(heard.some((toast) => toast.message.includes('could not install')))
			.toBe(true);

		// The failure cost nothing but the attempt: the download is still whole and still claimed by nobody.
		expect(existsSync(done))
			.toBe(true);

		expect(existsSync(join(incoming, 'a-skill', 'SKILL.md')))
			.toBe(true);
	}
);

test(
	'a claim that finds nothing to install does not arm a marker it cannot honour',
	async () => {
		const target = join(scratch, 'rearm-empty', 'target');
		const stamp = join(scratch, 'rearm-empty', 'stamp');
		const { incoming, done } = staging(target);

		// The marker without the download it records: the claim goes through, the install fails, and re-arming would loop that failure once per launch forever.
		mkdirSync(dirname(done), { recursive: true });
		writeFileSync(done, '');

		const { run } = listener();
		await run({ sources: [{ repo: 'someone/their-skills', target, stamp }] });

		expect(existsSync(done))
			.toBe(false);

		expect(existsSync(incoming))
			.toBe(false);
	}
);

test(
	'the plugin says nothing at all until it is configured',
	async () => {
		const { heard, run } = listener();

		await run({});
		await run({ sources: [] });

		expect(heard).toEqual([]);
	}
);

test(
	'the plugin reports malformed options rather than throwing on them',
	async () => {
		const cases = [
			// Not text and not a list, so there is nothing to read as a repository at all.
			{ sources: 42 },
			{ sources: [{ target: '/nowhere' }] },
			{ sources: [{ repo: 'someone/their-skills', target: 123 }] },
			{ sources: [], interval: 'daily' },
			{ source: ['anthropics/skills'] },
			// Text, but no `owner/repo` in it — refused here rather than handed to `gh` to fail on.
			{ sources: 'nope' },
			{ sources: [{ repo: 'not a repo' }] }
		];

		const { heard, run } = listener();

		for (const options of cases) {
			await run(options);
		}

		expect(heard.map((toast) => toast.type))
			.toEqual(['error', 'error', 'error', 'error', 'error', 'error', 'error']);

		expect(heard[0]?.message)
			.toContain('list of repositories');

		expect(heard[4]?.message)
			.toContain('`source`');

		expect(heard[5]?.message)
			.toContain('malformed source');
	}
);

test(
	'the plugin flags a stranger option even when the name shadows something Object inherits',
	async () => {
		const { heard, run } = listener();

		// `'toString' in KNOWN_OPTIONS` is true by inheritance, which would wave the typo through silently.
		await run({ sources: [], toString: true });

		expect(heard.some((toast) => toast.message.includes('unknown options') && toast.message.includes('toString')))
			.toBe(true);
	}
);

test(
	'the plugin accepts `sources` as a JSON string, since that is what the CLI stores',
	async () => {
		const target = join(scratch, 'string-form-target');
		const stamp = join(scratch, 'string-form-refreshed');
		writeFileSync(stamp, '');

		const { heard, run } = listener();

		await run({
			sources: JSON.stringify([{ repo: 'someone/their-skills', target, stamp }])
		});

		expect(heard).toEqual([]);
	}
);

test(
	'the plugin leaves the target alone when a placeholder would have taken it with it',
	async () => {
		const target = join(scratch, 'not-to-be-deleted');
		mkdirSync(join(target, 'precious-skill'), { recursive: true });
		writeFileSync(join(target, 'precious-skill', 'SKILL.md'), '');

		// A stamp written just now keeps the test off the network: the source counts as fresh, so the plugin only ensures the directory exists and sweeps staging.
		const stamp = join(scratch, 'refreshed-just-now');
		writeFileSync(stamp, '');

		const { run } = listener();

		await run({
			sources: [{ repo: 'someone/their-skills', target, stamp, placeholder: '' }]
		});

		expect(existsSync(join(target, 'precious-skill', 'SKILL.md')))
			.toBe(true);
	}
);
