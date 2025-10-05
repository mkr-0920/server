/**
 * @name cli.js
 * @description 一个自定义的、轻量级的命令行界面 (CLI) 参数解析器。
 * 负责定义、解析和验证命令行参数，并生成帮助信息。
 */

'use strict';

/**
 * @type {object} cli
 * @description 主CLI对象，采用链式调用设计。
 */
const cli = {
	width: 80, // 用于格式化帮助信息的默认宽度
	_program: {}, // 存储程序基本信息 (name, version)
	_options: [], // 存储所有已定义的选项

	/**
	 * 设置程序的基本信息
	 * @param {object} information - 包含 name 和 version 的对象
	 * @returns {cli} 返回 cli 对象本身以支持链式调用
	 */
	program: (information = {}) => {
		cli._program = information;
		return cli;
	},

	/**
	 * 定义一个命令行选项
	 * @param {string[]} flags - 选项的标志，如 ['-p', '--port']
	 * @param {object} addition - 选项的附加配置
	 * @returns {cli} 返回 cli 对象本身以支持链式调用
	 */
	option: (flags, addition = {}) => {
		flags = Array.isArray(flags) ? flags : [flags];
		// 自动从flag生成目标属性名，如 '--match-order' -> 'matchOrder'
		addition.dest =
			addition.dest ||
			flags
				.slice(-1)[0]
				.toLowerCase()
				.replace(/^-+/, '')
				.replace(/-[a-z]/g, (character) =>
					character.slice(1).toUpperCase()
				);
		// 为 'help' 和 'version' action 自动生成帮助文本
		addition.help =
			addition.help ||
			{
				help: 'output usage information',
				version: 'output the version number',
			}[addition.action];
		cli._options.push(
			Object.assign(addition, {
				flags: flags,
				// 判断是否为位置参数（不以 '-' 开头）
				positional: !flags[0].startsWith('-'),
			})
		);
		return cli;
	},

	/**
	 * 解析命令行参数数组 (process.argv)
	 * @param {string[]} argv - 命令行参数数组
	 * @returns {cli} 返回填充了值的 cli 对象
	 */
	parse: (argv) => {
		// 区分位置参数和可选参数
		const positionals = cli._options
				.map((option, index) => (option.positional ? index : null))
				.filter((index) => index !== null),
			optionals = {};
		cli._options.forEach((option, index) =>
			option.positional
				? null
				: option.flags.forEach((flag) => (optionals[flag] = index))
		);

		// 设置程序名
		cli._program.name =
			cli._program.name || require('path').parse(argv[1]).base;
		
		// 预处理参数：将合并的短选项（如 -vp）拆分为 -v 和 -p
		const args = argv.slice(2).reduce(
			(result, part) =>
				/^-[^-]/.test(part)
					? result.concat(
							part
								.slice(1)
								.split('')
								.map((string) => '-' + string)
						)
					: result.concat(part),
			[]
		);

		let pointer = 0;
		while (pointer < args.length) {
			let value = null;
			const part = args[pointer];
			const index = part.startsWith('-')
				? optionals[part]
				: positionals.shift();
			
			if (index === undefined)
				part.startsWith('-')
					? error(`no such option: ${part}`)
					: error(`extra arguments found: ${part}`);
			
			if (part.startsWith('-')) pointer += 1;
			
			const { action } = cli._options[index];

			// 根据 action 类型处理参数值
			if (['help', 'version'].includes(action)) {
				if (action === 'help') help();
				else if (action === 'version') version();
			} else if (['store_true', 'store_false'].includes(action)) {
				value = action === 'store_true';
			} else {
				// 消费参数值直到下一个选项
				const gap = args
					.slice(pointer)
					.findIndex((part) => part in optionals);
				const next = gap === -1 ? args.length : pointer + gap;
				value = args.slice(pointer, next);
				
				if (value.length === 0) {
					// 校验必需的参数值
					if (cli._options[index].positional)
						error(`the following arguments are required: ${part}`);
					else if (cli._options[index].nargs === '+')
						error(
							`argument ${part}: expected at least one argument`
						);
					else error(`argument ${part}: expected one argument`);
				}

				if (cli._options[index].nargs !== '+') {
					value = value[0]; // 如果不是多参数模式，只取第一个值
					pointer += 1;
				} else {
					pointer = next; // 如果是多参数模式，指针跳到下一个选项
				}
			}
			cli[cli._options[index].dest] = value;
		}

		// 检查是否有未满足的位置参数
		if (positionals.length)
			error(
				`the following arguments are required: ${positionals
					.map((index) => cli._options[index].flags[0])
					.join(', ')}`
			);
		
		return cli;
	},
};

// --- 帮助信息与错误处理函数 ---

/**
 * 在字符串末尾添加指定长度的空格
 * @param {number} length - 空格数量
 * @returns {string}
 */
const pad = (length) => new Array(length + 1).join(' ');

/**
 * 打印用法信息 (usage: ...)
 */
const usage = () => {
	const options = cli._options.map((option) => {
		const flag = option.flags.sort((a, b) => a.length - b.length)[0];
		const name = option.metavar || option.dest;
		if (option.positional) {
			if (option.nargs === '+') return `${name} [${name} ...]`;
			else return `${name}`;
		} else {
			if (['store_true', 'store_false', 'help', 'version'].includes(option.action))
				return `[${flag}]`;
			else if (option.nargs === '+')
				return `[${flag} ${name} [${name} ...]]`;
			else return `[${flag} ${name}]`;
		}
	});
	const maximum = cli.width;
	const title = `usage: ${cli._program.name}`;
	const lines = [title];

	// 格式化用法行，使其在达到宽度限制时能自动换行
	options
		.map((name) => ' ' + name)
		.forEach((option) => {
			lines[lines.length - 1].length + option.length < maximum
				? (lines[lines.length - 1] += option)
				: lines.push(pad(title.length) + option);
		});
	console.log(lines.join('\n'));
};

/**
 * 打印完整的帮助信息并退出程序
 */
const help = () => {
	usage(); // 首先打印用法
	const positionals = cli._options
		.filter((option) => option.positional)
		.map((option) => [option.metavar || option.dest, option.help]);
	const optionals = cli._options
		.filter((option) => !option.positional)
		.map((option) => {
			const { flags } = option;
			const name = option.metavar || option.dest;
			let use;
			if (['store_true', 'store_false', 'help', 'version'].includes(option.action))
				use = flags.map((flag) => `${flag}`).join(', ');
			else if (option.nargs === '+')
				use = flags
					.map((flag) => `${flag} ${name} [${name} ...]`)
					.join(', ');
			else use = flags.map((flag) => `${flag} ${name}`).join(', ');
			return [use, option.help];
		});
	
	// 计算对齐宽度，使帮助文本整齐
	let align = Math.max.apply(
		null,
		positionals.concat(optionals).map((option) => option[0].length)
	);
	align = align > 30 ? 30 : align;
	const rest = cli.width - align - 4;

	// 打印每个选项及其帮助文本
	const publish = (option) => {
		// 辅助函数，用于将长帮助文本切片并换行
		const slice = (string) =>
			Array.from(Array(Math.ceil(string.length / rest)).keys())
				.map((index) => string.slice(index * rest, (index + 1) * rest))
				.join('\n' + pad(align + 4));
		option[0].length < align
			? console.log(
					`  ${option[0]}${pad(align - option[0].length)}  ${slice(
						option[1]
					)}`
				)
			: console.log(
					`  ${option[0]}\n${pad(align + 4)}${slice(option[1])}`
				);
	};
	if (positionals.length) console.log('\npositional arguments:');
	positionals.forEach(publish);
	if (optionals.length) console.log('\noptional arguments:');
	optionals.forEach(publish);
	process.exit();
};

/**
 * 打印版本信息并退出程序
 */
const version = () => {
	console.log(cli._program.version);
	process.exit();
};

/**
 * 打印错误信息并退出程序
 * @param {string} message - 错误信息
 */
const error = (message) => {
	usage();
	console.log(cli._program.name + ':', 'error:', message);
	process.exit(1);
};

// 导出 cli 对象
module.exports = cli;