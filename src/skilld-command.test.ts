import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { expect, test } from 'bun:test';
import plugin from './skilld.ts';

interface Completion {
	value: string;
	label: string;
	description?: string;
}

interface CommandRegistration {
	getArgumentCompletions?: (argumentPrefix: string) => Completion[] | null;
}

const completionProvider = () => {
	let provider: CommandRegistration['getArgumentCompletions'];

	const pi = {
		on: () => undefined,
		registerCommand: (name: string, options: CommandRegistration) => {
			if (name === 'skilld') {
				provider = options.getArgumentCompletions;
			}
		}
	} as unknown as ExtensionAPI;

	plugin(pi);

	if (provider === undefined) {
		throw new Error('/skilld did not register argument completions');
	}

	return provider;
};

test(
	'/skilld suggests subcommands with descriptions',
	() => {
		const complete = completionProvider();

		expect(complete(''))
			.toEqual([
				{ value: 'status ', label: 'status', description: 'Show configured skill source status' },
				{ value: 'refresh ', label: 'refresh', description: 'Refresh one or all configured skill sources' }
			]);

		expect(complete('st'))
			.toEqual([
				{ value: 'status ', label: 'status', description: 'Show configured skill source status' }
			]);

		expect(complete('ST'))
			.toEqual([
				{ value: 'status ', label: 'status', description: 'Show configured skill source status' }
			]);

		expect(complete('  st'))
			.toEqual([
				{ value: 'status ', label: 'status', description: 'Show configured skill source status' }
			]);
	}
);

test(
	'/skilld stops subcommand completion after the first argument',
	() => {
		const complete = completionProvider();

		expect(complete('refresh '))
			.toBeNull();

		expect(complete('re fresh'))
			.toBeNull();
	}
);

test(
	'/skilld returns no completions for an unknown prefix',
	() => {
		expect(completionProvider()('unknown'))
			.toBeNull();
	}
);
