/**
 * @name request.js
 * @description 项目的底层网络请求模块。
 * 封装了Node.js的http和https模块，提供了Promise接口、代理、重定向、解压缩等功能。
 */

// 导入依赖模块
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const ON_CANCEL = require('./cancel');
const RequestCancelled = require('./exceptions/RequestCancelled');
const { logScope } = require('./logger');

// 初始化日志记录器
const logger = logScope('request');

// 设置全局请求超时阈值为10秒
const timeoutThreshold = 10 * 1000;

/**
 * 转换主机名，如果全局hosts中有定义，则使用指定的IP地址
 * @param {string} host 主机名
 * @returns {string} 转换后的主机名或IP
 */
const translate = (host) => (global.hosts || {})[host] || host;

/**
 * 根据URL协议和代理设置，选择使用 http.request 或 https.request
 * @param {URL} url - WHATWG URL 对象
 * @param {URL | null} proxy - 代理URL对象
 * @returns {http.request | https.request}
 */
const create = (url, proxy) =>
	(((typeof proxy === 'undefined' ? global.proxy : proxy) || url).protocol ===
	'https:'
		? https
		: http
	).request;

/**
 * 根据请求参数和代理设置，构建Node.js http/https 请求所需的 options 对象
 * @param {string} method - 请求方法 (GET, POST, etc.)
 * @param {URL} url - 目标URL对象
 * @param {http.OutgoingHttpHeaders} headers - 请求头
 * @param {URL | null} proxy - 代理URL对象
 * @returns {http.RequestOptions}
 */
const configure = (method, url, headers, proxy) => {
	headers = headers || {};
	proxy = typeof proxy === 'undefined' ? global.proxy : proxy;
	// 移除 content-length，让Node.js自动计算
	if ('content-length' in headers) delete headers['content-length'];

	const options = {};
	options._headers = headers; // 存储原始headers，用于CONNECT隧道

	if (proxy && url.protocol === 'https:') {
		// HTTPS over HTTP/HTTPS Proxy (CONNECT Tunnel)
		options.method = 'CONNECT';
		options.headers = Object.keys(headers).reduce(
			(result, key) =>
				Object.assign(
					result,
					['host', 'user-agent'].includes(key) && {
						[key]: headers[key],
					}
				),
			{}
		);
	} else {
		// 标准请求
		options.method = method;
		options.headers = headers;
	}

	if (proxy) {
		// 如果使用代理，请求的目标是代理服务器
		options.hostname = translate(proxy.hostname);
		options.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
		// 核心修改：使用 pathname 和 search 替换 path
		options.path =
			url.protocol === 'https:'
				? translate(url.hostname) + ':' + (url.port || 443)
				: url.href;
	} else {
		// 如果不使用代理，请求的目标是原始URL
		options.hostname = translate(url.hostname);
		options.port = url.port || (url.protocol === 'https:' ? 443 : 80);
		// 核心修改：使用 pathname 和 search 替换 path
		options.path = url.pathname + url.search;
	}
	return options;
};

/**
 * 主请求函数
 * @param {string} method - 请求方法
 * @param {string} receivedUrl - 请求的URL字符串
 * @param {object?} receivedHeaders - 请求头对象
 * @param {any?} body - 请求体
 * @param {URL?} proxy - 代理URL对象
 * @param {object?} cancelRequest - 可取消请求的控制器
 * @returns {Promise<http.IncomingMessage>} 扩展后的响应对象
 */
const requestFn = (
	method,
	receivedUrl,
	receivedHeaders,
	body,
	proxy,
	cancelRequest
) => {
	// 核心修改：使用 new URL() 替换 url.parse()
	const url = new URL(receivedUrl);
	const headers = receivedHeaders || {};
	const options = configure(
		method,
		url,
		{
			host: url.hostname,
			accept: 'application/json, text/plain, */*',
			'accept-encoding': 'gzip, deflate, br', // 增加 br 支持
			'accept-language': 'zh-CN,zh;q=0.9',
			'user-agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
			...headers,
		},
		proxy
	);

	return new Promise((resolve, reject) => {
		logger.debug(`Start requesting ${url.href}`);

		const clientRequest = create(url, proxy)(options);
		const destroyClientRequest = function () {
			// 核心修改：使用 url.href 替换 format(url)
			clientRequest.destroy(new RequestCancelled(url.href));
		};

		// 绑定取消请求的事件
		cancelRequest?.on(ON_CANCEL, destroyClientRequest);
		if (cancelRequest?.cancelled ?? false) destroyClientRequest();

		clientRequest
			.setTimeout(timeoutThreshold, () => {
				// 核心修改：使用 url.href 替换 format(url)
				logger.warn({ url: url.href }, `The request timed out.`);
				destroyClientRequest();
			})
			.on('response', (response) => resolve(response))
			.on('connect', (_, socket) => {
				// 处理 CONNECT 隧道建立成功后的情况
				logger.debug('Received CONNECT, continuing with https.request()...');
				// 核心修改：使用 pathname 和 search 替换 path
				const httpsPath = url.pathname + url.search;
				https
					.request({
						method: method,
						path: httpsPath,
						headers: options._headers,
						socket: socket,
						agent: false,
					})
					.on('response', (response) => resolve(response))
					.on('error', (error) => reject(error))
					.end(body);
			})
			.on('error', (error) => reject(error))
			.end(options.method.toUpperCase() === 'CONNECT' ? undefined : body);
	}).then((response) => {
		// 核心修改：使用 url.href 替换 format(url)
		if (cancelRequest?.cancelled ?? false)
			return Promise.reject(new RequestCancelled(url.href));

		// 处理 3xx 重定向
		if ([201, 301, 302, 303, 307, 308].includes(response.statusCode)) {
			// 核心修改：使用 new URL(relative, base) 替换 url.resolve()
			const redirectTo = new URL(response.headers.location || url.href, url).href;
			logger.debug(`Redirect to ${redirectTo}`);
			delete headers.host;
			return requestFn(method, redirectTo, headers, body, proxy);
		}

		// 为响应对象扩展 body, json, jsonp 等便捷方法
		return Object.assign(response, {
			url,
			body: (raw) => read(response, raw),
			json: () => json(response),
			jsonp: () => jsonp(response),
		});
	});
};

/**
 * 读取并解压缩响应体
 * @param {http.IncomingMessage} connect - 响应流
 * @param {boolean} raw - 是否返回原始 Buffer
 * @returns {Promise<Buffer|string>}
 */
const read = (connect, raw) =>
	new Promise((resolve, reject) => {
		const chunks = [];
		connect
			.on('data', (chunk) => chunks.push(chunk))
			.on('end', () => resolve(Buffer.concat(chunks)))
			.on('error', (error) => reject(error));
	}).then((buffer) => {
		if (buffer.length) {
			// 根据 content-encoding 自动解压缩
			return new Promise((resolve, reject) => {
				const cb = (err, result) => {
					if (err) return reject(err);
					resolve(raw ? result : result.toString());
				};
				switch (connect.headers['content-encoding']) {
					case 'deflate':
					case 'gzip':
						zlib.unzip(buffer, cb);
						break;
					case 'br':
						zlib.brotliDecompress(buffer, cb);
						break;
					default:
						resolve(raw ? buffer : buffer.toString());
						break;
				}
			});
		}
		return raw ? buffer : buffer.toString();
	});

// 辅助函数，用于将响应体直接解析为 JSON 或 JSONP
const json = (connect) => read(connect, false).then((body) => JSON.parse(body));
const jsonp = (connect) =>
	read(connect, false).then((body) =>
		JSON.parse(body.slice(body.indexOf('(') + 1, -')'.length))
	);

// 将内部函数附加到主函数上，供外部模块使用
requestFn.read = read;
requestFn.create = create;
requestFn.translate = translate;
requestFn.configure = configure;

module.exports = requestFn;