/**
 * @name bridge.js
 * @description 一个轻量级的HTTP桥接服务，用于通过API方式调用音源模块的功能。
 * 它将 provider 的函数暴露为 HTTP 端点，方便其他进程或服务调用。
 * 例如，访问 /qq/check?{...} 相当于调用 qq.check({...})。
 */

// 导入依赖模块
const http = require('http');
const { getManagedCacheStorage, CacheStorageGroup } = require('./cache');

// 禁用 insure 模块（根据原始代码，此模块可能用于功能保障，此处禁用）
require('./provider/insure').disable = true;

// 导入所有音源提供者作为路由表
const router = require('./consts').PROVIDERS;

// 初始化此模块专用的缓存，并设置15分钟的有效期
const cs = getManagedCacheStorage('bridge');
cs.aliveDuration = 15 * 60 * 1000;

/**
 * 动态路由和分发函数
 * @param {URL} url - WHATWG URL 对象，由 new URL() 创建
 * @param {object} router - 包含所有 provider 函数的路由对象
 * @returns {Promise<any>} 返回 provider 函数执行结果的 Promise
 */
const distribute = async (url, router) => {
	// 1. 解析路由：将 /path/to/function 解析为 ['path', 'to', 'function']
	const route = url.pathname
		.slice(1) // 移除开头的 "/"
		.split('/')
		.map((path) => decodeURIComponent(path));

	// 2. 准备参数：获取 URL 查询字符串 (不含 '?')
	let argument = url.search.substring(1);
	argument = decodeURIComponent(argument);

	let pointer = router; // 将指针指向路由表的根

	// 3. 尝试将参数解析为 JSON 对象
	try {
		argument = JSON.parse(argument);
	} catch (e) {
		// 解析失败则保持为字符串，不做处理
	}

	// 4. 遍历路由路径，在路由表中寻找目标函数
	const miss = route.some((path) => {
		if (path in pointer) {
			pointer = pointer[path]; // 逐级深入路由对象
			return false;
		}
		return true; // 如果路径不存在，则标记为 miss (未命中)
	});

	// 5. 如果路径错误或最终找到的不是一个函数，则拒绝请求
	if (miss || typeof pointer !== 'function') {
		throw new Error('Route not found or not a function.');
	}

	// 6. 使用缓存包装器执行目标函数，并将参数传入
	return cs.cache(argument, () => pointer(argument));
};

// 启动一个后台任务，每15分钟清理一次所有缓存实例
const csgInstance = CacheStorageGroup.getInstance();
setInterval(() => {
	csgInstance.cleanup();
}, 15 * 60 * 1000);

// --- 服务器创建与请求处理 ---

// 创建一个 HTTP 服务器
http.createServer()
	// 监听命令行参数指定的第3个参数为端口号 (node bridge.js <port>)，或默认为 9000
	.listen(parseInt(process.argv[2], 10) || 9000)
	// 为每个收到的请求绑定处理逻辑
	.on('request', async (req, res) => {
		// 核心修改：使用 new URL() 替换 url.parse()
		// 提供一个虚拟的 base URL 来处理相对路径的 req.url
		const requestUrl = new URL(req.url, 'http://localhost');

		try {
			// 调用分发函数处理请求
			const data = await distribute(requestUrl, router);
			// 成功时，将数据作为 JSON 字符串写入响应
			res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
			// 确保返回的是字符串格式
			const responseBody = typeof data === 'object' ? JSON.stringify(data) : String(data);
			res.write(responseBody);
		} catch (error) {
			// 失败时（如路由不存在），返回 404 Not Found
			res.writeHead(404);
		} finally {
			// 无论成功或失败，最后都结束响应，确保连接被关闭
			res.end();
		}
	});