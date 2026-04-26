/**
 * @name app.js
 * @description 应用主入口文件：负责解析命令行参数、配置全局变量、启动服务。
 */

// 导入依赖模块
const packageJson = require('../package.json');
const cli = require('./cli.js');
const net = require('net');
const { logScope } = require('./logger');
const hook = require('./hook');
const server = require('./server');
const { CacheStorageGroup } = require('./cache');
const request = require('./request'); // 引入 request 以便在 httpdns 中使用
const dns = require('dns'); // 引入 dns 模块

// 初始化日志记录器
const logger = logScope('app');

// --- 1. 命令行参数定义与解析 ---

// 使用 cli.js 模块定义所有可用的命令行选项
const config = cli
	.program({
		name: packageJson.name.replace(/@.+\//, ''),
		version: packageJson.version,
	})
	.option(['-v', '--version'], { action: 'version' })
	.option(['-p', '--port'], {
		metavar: 'http[:https]',
		help: '指定服务监听的端口',
	})
	.option(['-a', '--address'], {
		metavar: 'address',
		help: '指定服务监听的地址',
	})
	.option(['-u', '--proxy-url'], {
		metavar: 'url',
		help: '设置上游代理服务器',
	})
	.option(['-f', '--force-host'], {
		metavar: 'host',
		help: '强制指定网易云服务器IP',
	})
	.option(['-o', '--match-order'], {
		metavar: 'source',
		nargs: '+',
		help: '设置音源匹配的优先级顺序',
	})
	.option(['-t', '--token'], {
		metavar: 'token',
		help: '设置代理的认证口令',
	})
	.option(['-e', '--endpoint'], {
		metavar: 'url',
		help: '设置对外暴露的端点地址',
	})
	.option(['-s', '--strict'], {
		action: 'store_true',
		help: '开启严格模式，仅放行白名单域名',
	})
	.option(['-c', '--cnrelay'], {
		metavar: 'cnrelay',
		help: '为大陆外服务器指定获取音源的国内中继',
	})
	.option(['-h', '--help'], { action: 'help' })
	.parse(process.argv);

// --- 2. 参数校验与预处理 ---

// 校验端口号
global.address = config.address;
config.port = (config.port || '58081:58082')
	.split(':')
	.map((string) => parseInt(string, 10)); // 使用基数10进行转换

const isPortInvalid = (value) => isNaN(value) || value < 1 || value > 65535;
if (config.port.some(isPortInvalid)) {
	console.log('错误：端口号必须是 1-65535 之间的数字。');
	process.exit(1);
}

// 校验上游代理URL格式
try {
	if (config.proxyUrl) new URL(config.proxyUrl);
} catch (e) {
	console.log('错误：上游代理URL格式不正确，请使用 http(s)://host:port 的格式。');
	process.exit(1);
}

// 校验并设置 endpoint 地址
if (!config.endpoint) {
	config.endpoint = 'https://music.163.com';
} else if (config.endpoint === '-') {
	config.endpoint = '';
} else if (!/http(s?):\/\/.+/.test(config.endpoint)) {
	console.log('错误：Endpoint地址格式不正确。');
	process.exit(1);
}

// 校验强制Host格式
if (config.forceHost && net.isIP(config.forceHost) === 0) {
	console.log('错误：强制指定的Host必须为有效的IP地址。');
	process.exit(1);
}

// 校验音源匹配顺序
if (config.matchOrder) {
	const provider = Object.keys(require('./consts').PROVIDERS);
	const candidate = config.matchOrder;
	if (candidate.some((key, index) => index !== candidate.indexOf(key))) {
		console.log('错误：音源匹配顺序 (-o) 中存在重复的音源。');
		process.exit(1);
	} else if (candidate.some((key) => !provider.includes(key))) {
		console.log('错误：音源匹配顺序 (-o) 中包含未知的音源名称。');
		process.exit(1);
	}
	global.source = candidate;
}

// 校验认证口令格式
if (config.token && !/\S+:\S+/.test(config.token)) {
	console.log('错误：认证口令 (-t) 格式不正确，应为 user:pass 的格式。');
	process.exit(1);
}

// --- 3. 全局变量与服务配置 ---

const target = Array.from(hook.target.host);

// 设置全局变量
global.port = config.port;
// 核心修改：使用 new URL() 替换 url.parse()
global.proxy = config.proxyUrl ? new URL(config.proxyUrl) : null;
global.hosts = target.reduce(
	(result, host) => Object.assign(result, { [host]: config.forceHost }),
	{}
);
global.cnrelay = config.cnrelay;
global.endpoint = config.endpoint;

// 配置 server 模块
server.authentication = config.token || null;
server.whitelist = [
	'://[\\w.]*gstatic\\.com', // 放行 Clash 等客户端的延迟测试域名
	'://[\\w.]*music\\.126\\.net',
	'://[\\w.]*vod\\.126\\.net',
	'://acstatic-dun.126.net',
	'://[\\w.]*\\.netease.com',
	'://[\\w.]*\\.163yun.com',
];
if (config.strict) {
	server.blacklist.push('.*'); // 开启严格模式
}
if (config.endpoint) {
	// 使用正则表达式安全地转义 endpoint，防止注入
	const escapedEndpoint = config.endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	server.whitelist.push(escapedEndpoint);
}

// --- 4. DNS查询与HTTPDNS功能 ---

const dnsLookup = (host) =>
	new Promise((resolve, reject) =>
		dns.lookup(host, { all: true }, (error, records) =>
			error
				? reject(error)
				: resolve(records.map((record) => record.address))
		)
	);
const httpdns = async (host) => {
	try {
		const response = await request('POST', 'http://music.httpdns.c.163.com/d', {}, host);
		const jsonBody = await response.json();
		return jsonBody.dns.reduce(
			(result, domain) => result.concat(domain.ips),
			[]
		);
	} catch (e) {
		return [];
	}
};

const httpdns2 = async (host) => {
	try {
		const response = await request('GET', 'http://httpdns.n.netease.com/httpdns/v2/d?domain=' + host);
		const jsonBody = await response.json();
		return Object.keys(jsonBody.data)
			.map((key) => jsonBody.data[key])
			.reduce((result, value) => result.concat(value.ip || []), []);
	} catch (e) {
		return [];
	}
};
// 注意：HTTPDNS功能似乎已损坏，不建议开启
const dnsSource =
	process.env.ENABLE_HTTPDNS === 'true' ? [httpdns, httpdns2] : [];

// --- 5. 启动后台任务与服务器 ---

// 启动定时清理缓存的任务 (每15分钟)
const csgInstance = CacheStorageGroup.getInstance();
setInterval(() => {
	csgInstance.cleanup();
}, 15 * 60 * 1000);

// 并行执行所有DNS查询，以扩充域名白名单
(async () => {
	try {
		const result = await Promise.all(
			dnsSource.map((query) => query(target.join(','))).concat(target.map(dnsLookup))
		);
		const { host } = hook.target;
		// 将DNS查询到的IP地址和CNAME域名也加入到hook的目标中
		result.forEach((array) => array.forEach(host.add, host));
		// 将所有解析到的域名和IP安全地添加到白名单
		const escapedHosts = Array.from(host).map((h) =>
			h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		);
		server.whitelist = server.whitelist.concat(escapedHosts);

		// 日志记录函数
		const log = (type) =>
			logger.info(
				`${['HTTP', 'HTTPS'][type]} Server running @ http://${
					global.address || '0.0.0.0'
				}:${global.port[type]}`
			);

		// 启动HTTP和HTTPS服务器
		if (global.port[0]) {
			server.http
				.listen(global.port[0], global.address)
				.once('listening', () => log(0));
		}
		if (global.port[1]) {
			server.https
				.listen(global.port[1], global.address)
				.once('listening', () => log(1));
		}
		if (global.cnrelay) {
			logger.info(`CNRelay is enabled: ${global.cnrelay}`);
		}

		if (global.endpoint) {
			logger.info(`Startup Mode: [PROXY/FORWARDING] via endpoint: ${global.endpoint}`);
		} else {
			logger.info('Startup Mode: [DIRECT/PASSTHROUGH] (Package proxy is disabled)');
		}
	} catch (error) {
		console.error('启动失败:', error);
		process.exit(1);
	}
})();