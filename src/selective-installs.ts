import { Buffer } from 'node:buffer';

interface SourceWithSkills {
	skills?: unknown;
}

const sourceWithSkills = (source: unknown): SourceWithSkills | undefined => {
	if (typeof source !== 'object' || source === null || Array.isArray(source)) {
		return undefined;
	}

	return source as SourceWithSkills;
};

const malformedTargetSpelling = (target: string) => target.length === 0 || target.trim() !== target || target.startsWith('/') || target.includes('\\') || /[\0\r\n]/.test(target);

const malformedTargetPart = (part: string) => part.length === 0 || part === '.' || part === '..';

/** A skill name or repository-relative path that can be handed straight to `gh skill install`. */
const isSkillTarget = (target: unknown): target is string => {
	if (typeof target !== 'string' || malformedTargetSpelling(target)) {
		return false;
	}

	const parts = target.split('/');
	if (parts.some(malformedTargetPart)) {
		return false;
	}

	if (parts.at(-1) === 'SKILL.md') {
		return parts.length > 1;
	}

	return true;
};

/** The flat directory name `gh skill install --dir` publishes for one requested skill. */
const installedName = (target: string) => {
	const parts = target.split('/');
	if (parts.at(-1) === 'SKILL.md') {
		return parts.at(-2) as string;
	}

	return parts.at(-1) as string;
};

const registerSkillTarget = (target: string, targets: Set<string>, names: Map<string, string>): string | undefined => {
	if (targets.has(target)) {
		return `\`skills\` contains the duplicate target ${JSON.stringify(target)}`;
	}

	targets.add(target);

	const name = installedName(target);
	const previous = names.get(name);
	if (previous !== undefined) {
		return `\`skills\` targets ${JSON.stringify(previous)} and ${JSON.stringify(target)} both install as ${JSON.stringify(name)}`;
	}

	names.set(name, target);

	return undefined;
};

/** Explains only the optional `skills` field; the rest of a source is validated by `isSource`. */
const skillTargetsError = (source: unknown): string | undefined => {
	const configured = sourceWithSkills(source);
	if (configured === undefined || configured.skills === undefined) {
		return undefined;
	}

	if (!Array.isArray(configured.skills) || configured.skills.length === 0) {
		return '`skills` must be a non-empty array of exact skill names or repository-relative paths';
	}

	const targets = new Set<string>();
	const names = new Map<string, string>();

	for (const target of configured.skills) {
		if (!isSkillTarget(target)) {
			return `\`skills\` contains a malformed target: ${JSON.stringify(target)}`;
		}

		const registrationError = registerSkillTarget(target, targets, names);
		if (registrationError !== undefined) {
			return registrationError;
		}
	}

	return undefined;
};

/** Called only after {@link skillTargetsError}; the original array is preserved so `gh` receives exactly what the user configured. */
const configuredSkillTargets = (source: unknown): string[] | undefined => {
	const configured = sourceWithSkills(source);
	if (configured === undefined || configured.skills === undefined) {
		return undefined;
	}

	return configured.skills as string[];
};

/** The direct argv for one selected target. Absence of `skills` keeps using internals' existing `--all` argv instead. */
const selectedInstallArguments = (repo: string, pin: string | undefined, target: string, incoming: string) => {
	const args = ['skill', 'install', repo, target];
	if (pin !== undefined) {
		args.push('--pin', pin);
	}

	args.push('--dir', incoming, '--force');

	return args;
};

/** Single-quoted for the POSIX shell wrapper, with embedded quotes closed, escaped and reopened. */
const q = (text: string) => `'${text.replaceAll('\'', `'\\''`)}'`;

/** A selected refresh stays one detached process by running its exact installs sequentially inside the same wrapper. */
const selectedInstallCommand = (repo: string, pin: string | undefined, skills: string[], incoming: string, done: string, failed: string, noise: string) => {
	const commands = skills
		.map((skill) => `gh ${selectedInstallArguments(repo, pin, skill, incoming).map(q).join(' ')} 2>> ${q(noise)}`)
		.join(' && ');

	return `: > ${q(noise)}; ${commands}; rc=$?; if [ "$rc" -eq 0 ]; then : > ${q(done)}; elif [ "$rc" -ne 127 ] && [ "$rc" -ne 126 ]; then : > ${q(failed)}; fi; exit "$rc"`;
};

/** Single-quoted for PowerShell; doubling an embedded quote is PowerShell's literal escape inside a single-quoted string. */
const psq = (text: string) => `'${text.replaceAll('\'', '\'\'')}'`;

const powerShellInvocation = (args: string[], failed: string) => {
	const literals = args.map(psq).join(', ');

	return [
		'try {',
		`\tif ($captureNoise) { & gh @(${literals}) 2>> $noise } else { & gh @(${literals}) 2>$null }`,
		'} catch [System.Management.Automation.CommandNotFoundException] {',
		'\texit 127',
		'}',
		'$rc = $LASTEXITCODE',
		'if ($rc -ne 0) {',
		`\tif ($rc -ne 127 -and $rc -ne 126) { try { [System.IO.File]::WriteAllText(${psq(failed)}, '') } catch {} }`,
		'\texit $rc',
		'}'
	].join('\n');
};

/**
 * Windows cannot rely on a POSIX shell, and a parent-side loop would die before starting later targets if OMP quit mid-refresh.
 * A detached PowerShell wrapper therefore owns the whole sequence and completion markers just like `sh` does elsewhere.
 */
const selectedInstallPowerShellArguments = (repo: string, pin: string | undefined, skills: string[], incoming: string, done: string, failed: string, noise: string) => {
	const commands = skills
		.map((skill) => powerShellInvocation(selectedInstallArguments(repo, pin, skill, incoming), failed))
		.join('\n');

	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$noise = ${psq(noise)}`,
		'$captureNoise = $true',
		'try { [System.IO.File]::WriteAllText($noise, \'\') } catch { $captureNoise = $false }',
		commands,
		`try { [System.IO.File]::WriteAllText(${psq(done)}, '') } catch {}`,
		'exit 0'
	].join('\n');

	const encoded = Buffer.from(script, 'utf16le').toString('base64');

	return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
};

export { configuredSkillTargets, selectedInstallArguments, selectedInstallCommand, selectedInstallPowerShellArguments, skillTargetsError };
