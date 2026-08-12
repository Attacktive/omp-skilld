/*
 * Everything `skilld.ts` needs but may not itself export.
 * omp takes the extension module's default export as the factory, so the plugin file gets exactly one export and no more; helpers live here to keep that file loadable and testable.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A floor on every toast, not just the first: a spawn failure lands within milliseconds, and its error toast would otherwise be the one nobody ever sees.
 * A toast fired while the TUI is still coming up goes nowhere.
 */
const TOAST_DELAY_MS = 3333;

/**
 * How long a download that has stopped touching its staging directory is given before it is taken for dead.
 * `gh` writes skills out as it goes, so a live download keeps the directory's mtime moving; only a launch killed hard enough to take the download with it — a reboot, a `SIGKILL` — leaves one standing still.
 */
const ABANDONED_MS = 15 * 60 * 1000;

/**
 * How long a failed download is left alone before another is attempted.
 * The skill API's rate limit is tight enough that a launch-per-attempt loop is the worst thing a failure could turn into — and an expired login or a spent limit is not fixed by trying again immediately.
 */
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * The shell's own verdicts on the command it was asked to run: 127 is "no such command", 126 is "found it, cannot run it".
 * Wrapping `gh` in `sh` is what turns a missing `gh` into an exit code instead of a spawn error, so these are the two codes that mean the download never started rather than failed.
 */
const NOT_FOUND = 127;

const NOT_EXECUTABLE = 126;

/**
 * Repositories started from GitHub's skill template ship a `template/` skill described as "Replace with description of the skill and when Claude should use it."
 * It has a description, so nothing filters it out, and a trigger that vague fires on almost anything — hence deleting it by default.
 */
const DEFAULT_PLACEHOLDER = 'template';

/**
 * What an unedited placeholder still says about itself.
 * The name alone is not evidence: a repository is free to ship a real skill called `template`, and deleting somebody's skill because of its directory name is not a trade this plugin gets to make.
 */
const PLACEHOLDER_DESCRIPTION = /Replace with description of the skill/i;

/** The package name, which is also the key under which omp stores this plugin's settings. */
const PLUGIN_NAME = 'omp-skilld';

interface SkillRepository {
	/** A GitHub `"owner/repo"` to pull skills from, e.g. `"anthropics/skills"`. */
	repo: string;
	target?: string;
	stamp?: string;
	label?: string;
	placeholder?: string | false;
}

type SkillSource = string | SkillRepository;

/** The documented shape of the options. Nothing enforces it — they come from a handwritten config file — so everything below validates rather than trusts. */
interface Options {
	sources?: SkillSource[];
	interval?: number;
}

interface NormalizedSource {
	repo: string;
	target: string;
	stamp: string;
	label: string;
	placeholder: string | false;
}

const slugify = (repo: string) => repo.replace(/\//g, '-');

/** `~` is a shell convention and nothing here goes through a shell, so an unexpanded path would become a directory literally named `~`. */
const expand = (path: string) => {
	if (path === '~') {
		return homedir();
	}

	if (path.startsWith('~/')) {
		return `${homedir()}${path.slice(1)}`;
	}

	return path;
};

/**
 * Refuses anything that is not a single directory name.
 * The placeholder is deleted with a recursive, forced `rmSync`, so an empty string would aim that at `target` itself and a path would aim it somewhere else entirely.
 */
const asPlaceholder = (placeholder: unknown): string | false => {
	if (placeholder === undefined) {
		return DEFAULT_PLACEHOLDER;
	}

	if (typeof placeholder !== 'string') {
		return false;
	}

	if (placeholder.length === 0 || placeholder === '.' || placeholder === '..' || placeholder.includes('/') || placeholder.includes('\\')) {
		return false;
	}

	return placeholder;
};

/** A non-empty string, which is the only text an option may hold: `''` survives `expand` untouched and would reach `mkdirSync` as an unrefreshable path. */
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isOptionalText = (value: unknown) => value === undefined || isText(value);

const asInterval = (interval: unknown): number | undefined => {
	if (interval === undefined) {
		return DEFAULT_INTERVAL_MS;
	}

	if (typeof interval === 'number' && Number.isFinite(interval)) {
		return interval;
	}

	return undefined;
};

/**
 * A GitHub `"owner/repo"` and nothing else.
 * A typo that reaches `gh` costs a failed download — and, since the failure is recorded rather than retried at once, a wait before the next attempt — so it is worth refusing here where it can be named.
 */
const isRepo = (repo: unknown): repo is string => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo);

/** The JSON a per-source override needs, as either the list it describes or the single source that is a list of one. */
const asJsonSources = (text: string): unknown[] | undefined => {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}

	if (Array.isArray(parsed)) {
		return parsed;
	}

	// A single object is as good as a list of one, and is what anybody pasting an example from the README is holding.
	if (typeof parsed === 'object' && parsed !== null) {
		return [parsed];
	}

	return undefined;
};

/**
 * The settings schema has no array type, so `omp plugin config set` stores whatever it is handed as text.
 * A bare list is what most configurations are — `anthropics/skills, someone/their-skills` — and JSON is there for the ones that override a path or a label.
 */
const asSources = (sources: unknown): unknown[] | undefined => {
	if (Array.isArray(sources)) {
		return sources;
	}

	if (typeof sources !== 'string') {
		return undefined;
	}

	const text = sources.trim();

	if (text.length === 0) {
		return [];
	}

	if (text.startsWith('[') || text.startsWith('{')) {
		return asJsonSources(text);
	}

	return text.split(/[\s,]+/).filter((entry) => entry.length > 0);
};

/** Everything downstream trusts what this passes — `normalize` takes it without checking again — so the optional fields have to hold their documented types too. */
const isSource = (source: unknown): source is SkillSource => {
	if (typeof source === 'string') {
		return isRepo(source);
	}

	if (typeof source !== 'object' || source === null) {
		return false;
	}

	const { repo, target, stamp, label, placeholder } = source as { [K in keyof SkillRepository]: unknown };

	if (!isRepo(repo)) {
		return false;
	}

	if (![target, stamp, label].every(isOptionalText)) {
		return false;
	}

	return placeholder === undefined || typeof placeholder === 'string' || placeholder === false;
};

/** The two directories a launch works in: where this plugin assembles downloads, and the skills directory omp scans without being asked to. */
interface Layout {
	root: string;
	linkRoot: string;
}

/**
 * Downloads live in `skilld/` beside the agent directory, which is the omp root in every layout omp resolves — `$XDG_DATA_HOME/omp` included, since the agent directory moves there with it.
 * A directory of this plugin's own, because a refresh stands its whole target in at once and `<agentDir>/skills` holds skills nobody downloaded; what goes into that one is a symlink per skill.
 */
const layout = (agentDir: string): Layout => ({ root: join(dirname(agentDir), 'skilld'), linkRoot: join(agentDir, 'skills') });

const normalize = (source: SkillSource, root: string): NormalizedSource => {
	let configured: SkillRepository;
	if (typeof source === 'string') {
		configured = { repo: source };
	} else {
		configured = source;
	}

	const slug = slugify(configured.repo);

	/*
	 * One directory per source, and the stamp hidden beside that directory rather than inside it: the target is what omp is pointed at, so everything this plugin keeps for its own bookkeeping stays out of it.
	 * Both are overridable per source, which is what a machine sharing a download with another tool overrides.
	 */
	const target = expand(configured.target ?? join(root, slug));
	const stamp = expand(configured.stamp ?? join(root, `.${slug}-refreshed`));

	return {
		repo: configured.repo,
		target,
		stamp,
		label: configured.label ?? configured.repo,
		placeholder: asPlaceholder(configured.placeholder)
	};
};

/** A stamp that cannot be read counts as stale: there has never been a successful refresh to go by. */
const isStale = (stamp: string, interval: number) => {
	try {
		const age = Date.now() - statSync(stamp).mtimeMs;

		return age > interval;
	} catch {
		return true;
	}
};

/**
 * Where a download is assembled before it stands in for the live directory, and where the live one is parked while they trade places.
 * Siblings of `target` rather than anything under `os.tmpdir()`, because a rename across filesystems fails with `EXDEV` and the copy it would take instead is not atomic.
 * Hidden, so a scan of the parent directory cannot mistake them for skills.
 * The markers record how a detached download ended, so a launch that missed its exit handler can tell a finished download from a failed one.
 */
const staging = (target: string) => {
	const hidden = `${dirname(target)}/.${basename(target)}`;

	return { incoming: `${hidden}.incoming`, outgoing: `${hidden}.outgoing`, done: `${hidden}.done`, failed: `${hidden}.failed` };
};

/** Single-quoted for the shell that wraps `gh`, with any quote in the text closed, escaped and reopened the way `sh` requires. */
const q = (text: string) => `'${text.replaceAll('\'', `'\\''`)}'`;

/**
 * The download, wrapped so that something which outlives this process records how it ended: the launch that started it may well be gone before it finishes, and the next one reads the markers it left.
 * The shell's own verdicts are exempt from the failure marker — a `gh` that was never found, or never ran, spent none of the rate limit the cooldown exists to protect, so installing it and relaunching works at once instead of after an hour.
 * Both markers are written with `:` and a redirection rather than `touch`, so nothing here depends on what is on `PATH` beyond `gh` itself.
 */
const installCommand = (repo: string, incoming: string, done: string, failed: string) => `gh skill install ${q(repo)} --all --dir ${q(incoming)} --force; rc=$?; if [ "$rc" -eq 0 ]; then : > ${q(done)}; elif [ "$rc" -ne ${NOT_FOUND} ] && [ "$rc" -ne ${NOT_EXECUTABLE} ]; then : > ${q(failed)}; fi; exit "$rc"`;

/**
 * Stands a finished download in for the live directory, so a half-written one is never what omp scans.
 * Not a single atomic step — nothing Node exposes can exchange two directories — but `target` is absent for two renames rather than for the length of a download.
 */
const swap = (target: string) => {
	const { incoming, outgoing } = staging(target);

	rmSync(outgoing, { recursive: true, force: true });

	/*
	 * A first refresh has no live directory to move aside.
	 * Conjuring an empty one to keep this branchless is what the failure path below would then restore, leaving behind exactly the installed-but-empty skill set that never creating `target` until a refresh succeeds is meant to rule out.
	 */
	const live = existsSync(target);

	if (live) {
		renameSync(target, outgoing);
	}

	try {
		renameSync(incoming, target);
	} catch (error) {
		// Never leave nothing behind: put the live directory back, if there was one at all, and let the caller report it.
		if (live) {
			renameSync(outgoing, target);
		}

		throw error;
	}

	try {
		rmSync(outgoing, { recursive: true, force: true });
	} catch {
		// The download is already live, so a parked directory that will not clear is no failed install — it is hidden, and the next launch sweeps it.
	}
};

/** Distinguishes a first launch, where `target` is missing outright, from a merely dated one. */
const isEmpty = (target: string) => {
	try {
		return readdirSync(target).length === 0;
	} catch {
		return true;
	}
};

/**
 * Deletes the placeholder skill a template repository ships, and only that: the directory has to still describe itself the way the template does.
 * A repository that ships a real skill under the same name keeps it, and a directory that is no skill at all — no `SKILL.md` — is left alone rather than guessed about.
 */
const dropPlaceholder = (incoming: string, placeholder: string | false) => {
	if (placeholder === false) {
		return false;
	}

	const candidate = join(incoming, placeholder);

	let description: string;

	try {
		description = readFileSync(join(candidate, 'SKILL.md'), 'utf8').slice(0, 2048);
	} catch {
		return false;
	}

	if (!PLACEHOLDER_DESCRIPTION.test(description)) {
		return false;
	}

	rmSync(candidate, { recursive: true, force: true });

	return true;
};

/** What a name in the skills directory already holds: nothing, a link this plugin put there, or something that is not this plugin's to touch. */
const claim = (link: string, target: string) => {
	let entry;

	try {
		entry = lstatSync(link);
	} catch {
		return 'free';
	}

	if (!entry.isSymbolicLink()) {
		return 'theirs';
	}

	try {
		// Where the link points, not where it resolves: a link left dangling by a skill that went away is still one this plugin wrote, and is the only kind it may remove.
		return readlinkSync(link).startsWith(`${target}${sep}`) ? 'ours' : 'theirs';
	} catch {
		return 'theirs';
	}
};

/** Links this plugin wrote for skills that are no longer in the download: the name has to be free again before anything else can claim it. */
const sweepLinks = (target: string, linkRoot: string) => {
	for (const name of readdirSync(linkRoot)) {
		const link = join(linkRoot, name);

		if (claim(link, target) === 'ours' && !existsSync(link)) {
			rmSync(link, { force: true });
		}
	}
};

/** The directories in a download that are skills: `gh` writes one per skill, and omp asks for the `SKILL.md` that makes it one. */
const installedSkills = (target: string) => readdirSync(target, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(target, entry.name, 'SKILL.md')))
	.map((entry) => entry.name);

/**
 * Publishes a finished download into the skills directory omp scans on its own, so a refresh is seen without anything having to be configured.
 * One symlink per skill rather than a copy, which omp's scan takes as readily as a directory — and which doubles as the record of what belongs to this plugin: a link into the target is this plugin's to remove, and everything else is left exactly where it is.
 * The links survive a refresh untouched, since what they point at is a path inside `target` and a swap only changes what that path holds.
 */
const linkSkills = (target: string, linkRoot: string) => {
	mkdirSync(linkRoot, { recursive: true });
	sweepLinks(target, linkRoot);

	// A junction is what Windows gives for a directory without asking for privileges.
	const kind = process.platform === 'win32' ? 'junction' : 'dir';

	const linked: string[] = [];
	const refused: string[] = [];

	for (const name of installedSkills(target)) {
		const link = join(linkRoot, name);
		const held = claim(link, target);

		if (held === 'ours') {
			continue;
		}

		if (held === 'theirs') {
			// A skill of the user's own under the same name outranks a downloaded one, and silently replacing it would be the one unrecoverable thing here.
			refused.push(name);
			continue;
		}

		symlinkSync(join(target, name), link, kind);
		linked.push(name);
	}

	return { linked, refused };
};

/** What an earlier launch's staging area leaves for this one to do. */
type StagingState = 'finish' | 'failed' | 'cooling' | 'in-flight' | 'skip';

/**
 * What the staging area left by an earlier launch says: a finished download to stand in, a failed one to sweep, one still running to leave alone, or nothing to go on.
 * The markers are what a launch that quit before its download did leaves behind, so the next one can finish the job instead of paying for the download again.
 */
const resolveStaging = (target: string, stamp: string, staleAfter: number): StagingState => {
	const { incoming, done, failed } = staging(target);

	if (existsSync(done)) {
		// Standing a finished download in beats downloading it again; a stamp that is still fresh makes the marker moot, since the refresh it records already happened.
		if (isStale(stamp, staleAfter)) {
			return 'finish';
		}

		rmSync(done, { force: true });

		return 'skip';
	}

	if (existsSync(failed)) {
		/*
		 * A download fails for reasons a second attempt rarely fixes within the same minute: no login, no network, a rate limit that has already been spent.
		 * The marker doubles as the cooldown, so a launch loop cannot turn one failure into an attempt per launch.
		 */
		if (Date.now() - statSync(failed).mtimeMs <= FAILURE_COOLDOWN_MS) {
			return 'cooling';
		}

		rmSync(failed, { force: true });
		rmSync(incoming, { recursive: true, force: true });

		return 'failed';
	}

	if (existsSync(incoming)) {
		/*
		 * A download still running owns the directory and is left alone — yanking it would cost the whole download again, and `gh` would write the rest of it into a directory that is no longer there.
		 * Deliberately not measured against the refresh interval: a short interval must not condemn a download that is merely still going, and a long one must not leave a hard-killed launch's debris sitting in front of a fresh start for a day.
		 */
		if (Date.now() - statSync(incoming).mtimeMs <= ABANDONED_MS) {
			return 'in-flight';
		}

		rmSync(incoming, { recursive: true, force: true });
	}

	return 'skip';
};

/** The extension factory runs once per session (subagents included); the sweep must run once per launch. Tests reset `.done` between cases. */
export const sweepGuard = { done: false };

/**
 * The bases omp looks in for a project-local override, in the order it tries them.
 * It reads other agents' directories too, so a project that configures omp through `.claude` is honoured the same way omp itself honours it.
 */
const OVERRIDE_BASES = ['.omp', '.claude', '.codex', '.gemini'];

/** Every project-local override path omp would consider, nearest first: each base at `cwd`, then the same bases at every ancestor. */
const overrideCandidates = (cwd: string) => {
	const candidates: string[] = [];

	let directory = cwd;

	for (;;) {
		candidates.push(...OVERRIDE_BASES.map((base) => join(directory, base, 'plugin-overrides.json')));

		const parent = dirname(directory);

		if (parent === directory) {
			return candidates;
		}

		directory = parent;
	}
};

/**
 * The lock omp keeps this plugin's settings in.
 * It lives under `<ompRoot>/plugins`, which is the agent directory's parent in every layout omp resolves — the XDG data root included, since the agent directory moves there with it.
 * The exception is an agent directory pointed elsewhere by `PI_CODING_AGENT_DIR`, which leaves the plugins where they were.
 */
const lockPath = (agentDir: string) => {
	const xdgDataHome = process.env.XDG_DATA_HOME;

	const candidates: string[] = [];

	if (xdgDataHome !== undefined && existsSync(join(xdgDataHome, 'omp', 'agent'))) {
		candidates.push(join(xdgDataHome, 'omp', 'plugins', 'omp-plugins.lock.json'));
	}

	candidates.push(join(dirname(agentDir), 'plugins', 'omp-plugins.lock.json'));

	if (process.env.PI_CODING_AGENT_DIR !== undefined && !agentDir.startsWith(join(homedir(), '.omp'))) {
		candidates.push(join(homedir(), '.omp', 'plugins', 'omp-plugins.lock.json'));
	}

	// First match wins; with none of them there, the first is the one whose absence means "not configured".
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? '';
};

/**
 * Read this plugin's settings the way omp persists them: `omp-plugins.lock.json` under the plugins dir, merged with the nearest project-local `plugin-overrides.json` — the project wins.
 * The override is searched for the way omp searches — every `.omp`, `.claude`, `.codex` and `.gemini` from `cwd` up to the root, nearest first, and the first one that parses is the one that counts.
 * A file that is not there is not an error (defaults say no-op); one that will not parse is, so the user hears why nothing refreshes.
 */
const readPluginSettings = async (agentDir: string, cwd: string): Promise<{ options: Record<string, unknown>; error?: string }> => {
	let options: Record<string, unknown> = {};
	let error: string | undefined;

	const read = (path: string) => {
		if (!existsSync(path)) {
			return;
		}

		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as { settings?: Record<string, Record<string, unknown>> };

			options = { ...options, ...(parsed.settings?.[PLUGIN_NAME] ?? {}) };
		} catch (cause) {
			error ??= `${path}: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	};

	read(lockPath(agentDir));

	/*
	 * Only the nearest override that parses applies, which is what omp does with them.
	 * A malformed one nearer than that is skipped rather than fatal — again omp's behaviour — but it is still reported, since a project override that silently does nothing is the hardest kind of configuration to debug.
	 */
	for (const candidate of overrideCandidates(cwd)) {
		if (!existsSync(candidate)) {
			continue;
		}

		const before = error;

		read(candidate);

		if (error === before) {
			break;
		}
	}

	return error === undefined ? { options } : { options, error };
};

export { DEFAULT_INTERVAL_MS, TOAST_DELAY_MS, DEFAULT_PLACEHOLDER, ABANDONED_MS, FAILURE_COOLDOWN_MS, NOT_FOUND, NOT_EXECUTABLE, PLUGIN_NAME, type SkillRepository, type SkillSource, type Options, type NormalizedSource, type StagingState, type Layout, slugify, expand, asInterval, asPlaceholder, asSources, isRepo, isSource, layout, normalize, staging, installCommand, swap, isStale, isEmpty, dropPlaceholder, linkSkills, resolveStaging, readPluginSettings };
