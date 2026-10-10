import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { configuredSkillTargets, selectedInstallArguments, selectedInstallCommand, selectedInstallPowerShellArguments, skillTargetsError } from './selective-installs.ts';

describe(
	'selective skill targets',
	() => {
		it(
			'accepts skill names and nested repository paths unchanged',
			() => {
				const source = { repo: 'owner/repo', skills: ['pdf', 'skills/engineering/reviewer'] };

				expect(skillTargetsError(source))
					.toBeUndefined();
				expect(configuredSkillTargets(source))
					.toEqual(['pdf', 'skills/engineering/reviewer']);
			}
		);

		it(
			'rejects empty, malformed and duplicate targets',
			() => {
				expect(skillTargetsError({ skills: [] }))
					.toContain('non-empty array');
				expect(skillTargetsError({ skills: ['../pdf'] }))
					.toContain('malformed target');
				expect(skillTargetsError({ skills: ['pdf', 'pdf'] }))
					.toContain('duplicate target');
			}
		);

		it(
			'rejects targets that would overwrite the same installed directory',
			() => {
				expect(skillTargetsError({ skills: ['skills/a/reviewer', 'skills/b/reviewer'] }))
					.toContain('both install as "reviewer"');
				expect(skillTargetsError({ skills: ['skills/a/reviewer', 'skills/b/reviewer/SKILL.md'] }))
					.toContain('both install as "reviewer"');
			}
		);
	}
);

describe(
	'selective install commands',
	() => {
		it(
			'passes one exact target without --all',
			() => {
				expect(selectedInstallArguments('owner/repo', 'v2.3.0', 'skills/engineering/reviewer', '/incoming'))
					.toEqual(['skill', 'install', 'owner/repo', 'skills/engineering/reviewer', '--pin', 'v2.3.0', '--dir', '/incoming', '--force']);
			}
		);

		it(
			'runs multiple POSIX installs sequentially inside one detached wrapper',
			() => {
				const command = selectedInstallCommand('owner/repo', undefined, ['pdf', 'skills/engineering/reviewer'], '/incoming', '/done', '/failed', '/noise');

				expect(command.match(/gh 'skill' 'install'/g))
					.toHaveLength(2);
				expect(command)
					.toContain("'owner/repo' 'pdf'");
				expect(command)
					.toContain("'owner/repo' 'skills/engineering/reviewer'");
				expect(command)
					.not.toContain('--all');
			}
		);

		it(
			'builds a detached Windows wrapper with every exact target',
			() => {
				const args = selectedInstallPowerShellArguments('owner/repo', undefined, ['pdf', 'skills/engineering/reviewer'], 'C:/incoming', 'C:/done', 'C:/failed', 'C:/noise');
				const encoded = args.at(-1) as string;
				const script = Buffer.from(encoded, 'base64').toString('utf16le');

				expect(args.slice(0, -1))
					.toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
				expect(script)
					.toContain("'owner/repo', 'pdf'");
				expect(script)
					.toContain("'owner/repo', 'skills/engineering/reviewer'");
				expect(script)
					.not.toContain('--all');
			}
		);
	}
);
