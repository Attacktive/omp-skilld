import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
			'rejects empty, malformed, versioned and duplicate targets',
			() => {
				expect(skillTargetsError({ skills: [] }))
					.toContain('non-empty array');
				expect(skillTargetsError({ skills: ['../pdf'] }))
					.toContain('malformed target');
				expect(skillTargetsError({ skills: ['pdf@v2.3.0'] }))
					.toContain('source `pin`');
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
			'passes one exact target after the option delimiter',
			() => {
				expect(selectedInstallArguments('owner/repo', 'v2.3.0', 'skills/engineering/reviewer', '/incoming'))
					.toEqual(['skill', 'install', 'owner/repo', '--pin', 'v2.3.0', '--dir', '/incoming', '--force', '--', 'skills/engineering/reviewer']);
				expect(selectedInstallArguments('owner/repo', undefined, '--all', '/incoming').slice(-2))
					.toEqual(['--', '--all']);
			}
		);

		it(
			'runs multiple POSIX installs sequentially inside one detached wrapper',
			() => {
				const command = selectedInstallCommand('owner/repo', undefined, ['pdf', 'skills/engineering/reviewer'], '/incoming', '/done', '/failed', '/noise');

				expect(command.match(/gh 'skill' 'install'/g))
					.toHaveLength(2);
				expect(command)
					.toContain("'owner/repo' '--dir' '/incoming' '--force' '--' 'pdf'");
				expect(command)
					.toContain("'owner/repo' '--dir' '/incoming' '--force' '--' 'skills/engineering/reviewer'");
				expect(command)
					.not.toContain("'--all' '--dir'");
			}
		);

		it(
			'keeps selected Windows installs off the command line and native stderr non-terminating',
			() => {
				const root = mkdtempSync(join(tmpdir(), 'omp-skilld-'));

				try {
					const noise = join(root, 'noise');
					const skills = Array.from({ length: 20 }, (_, index) => `skills/engineering/skill-${index}`);
					const args = selectedInstallPowerShellArguments('owner/repo', undefined, skills, join(root, 'incoming'), join(root, 'done'), join(root, 'failed'), noise);
					const scriptPath = args.at(-1) as string;
					const script = readFileSync(scriptPath, 'utf16le');

					expect(args.slice(0, -1))
						.toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
					expect(args.join(' ').length)
						.toBeLessThan(32_767);
					expect(args.join(' '))
						.not.toContain('skill-19');
					expect(script)
						.toContain("$ErrorActionPreference = 'Continue'");
					expect(script)
						.toContain('Get-Command gh -ErrorAction SilentlyContinue');
					expect(script)
						.toContain("'--', 'skills/engineering/skill-19'");
					expect(script)
						.not.toContain("$ErrorActionPreference = 'Stop'");
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		);

		it(
			'runs the selected Windows wrapper through ordinary gh stderr',
			() => {
				if (process.platform !== 'win32') {
					return;
				}

				const root = mkdtempSync(join(tmpdir(), 'omp-skilld-'));

				try {
					const gh = join(root, 'gh.cmd');
					const done = join(root, 'done');
					const failed = join(root, 'failed');
					const noise = join(root, 'noise');
					writeFileSync(gh, '@echo off\r\necho Using ref v7.0.0 1>&2\r\nexit /b 0\r\n');

					const args = selectedInstallPowerShellArguments('owner/repo', undefined, ['pdf', 'skills/engineering/reviewer'], join(root, 'incoming'), done, failed, noise);
					const environment = { ...process.env };
					const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
					environment[pathKey] = `${root}${delimiter}${environment[pathKey] ?? ''}`;

					const result = spawnSync('powershell.exe', args, { env: environment, stdio: 'ignore' });

					expect(result.status)
						.toBe(0);
					expect(existsSync(done))
						.toBe(true);
					expect(existsSync(failed))
						.toBe(false);
					expect(readFileSync(noise).length)
						.toBeGreaterThan(0);
					expect(existsSync(`${noise}.ps1`))
						.toBe(false);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		);
	}
);
