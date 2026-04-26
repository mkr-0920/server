/**
 * @name server.js
 * @description 项目的核心代理服务器引擎。
 * 负责创建HTTP和HTTPS服务器，定义请求处理流水线，并集成 hook.js 的逻辑。
 */

// 导入Node.js核心模块
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');

// 导入项目内部模块
const { logScope } = require('./logger');
const sni = require('./sni');
const hook = require('./hook');
const request = require('./request');
const { isHost } = require('./utilities');

// 初始化日志记录器
const logger = logScope('server');

/**
 * @type {object} proxy
 * @description 包含代理服务器所有核心逻辑和处理函数的对象。
 */
const proxy = {
	/**
	 * 核心请求处理器，分为 mitm (HTTP处理) 和 tunnel (HTTPS处理)
	 */
	core: {
		/**
		 * HTTP请求处理流水线 (Man-in-the-Middle for HTTP)
		 * @param {http.IncomingMessage} req
		 * @param {http.ServerResponse} res
		 */
		mitm: async (req, res) => {
			// 特殊情况：处理代理自动配置 (PAC) 文件请求
			if (req.url === '/proxy.pac') {
				// 核心修改：使用 new URL() 替换 url.parse()
				const url = new URL('http://' + req.headers.host);
				res.writeHead(200, {
					'Content-Type': 'application/x-ns-proxy-autoconfig',
				});
				res.end(`
          function FindProxyForURL(url, host) {
            if (${Array.from(hook.target.host)
				.map((host) => `host == '${host}'`)
				.join(' || ')}) {
              return 'PROXY ${url.hostname}:${url.port || 80}'
            }
            return 'DIRECT'
          }
        `);
			} else {
				// 标准HTTP请求处理流程
				const ctx = { res, req };
				try {
					await proxy.protect(ctx); // 1. 挂载错误处理器
					await proxy.authenticate(ctx); // 2. 代理身份认证
					await hook.request.before(ctx); // 3. 执行前置钩子 (我们的核心逻辑)
					await proxy.filter(ctx); // 4. 黑白名单过滤
					await proxy.log(ctx); // 5. 记录请求日志
					await proxy.mitm.request(ctx); // 6. 转发请求到目标服务器
					await hook.request.after(ctx); // 7. 执行后置钩子 (我们的核心逻辑)
					await proxy.mitm.response(ctx); // 8. 将响应返回给客户端
				} catch (error) {
					proxy.mitm.close(ctx); // 捕获异常并关闭连接
				}
			}
		},
		/**
		 * HTTPS隧道请求处理流水线 (CONNECT method)
		 * @param {http.IncomingMessage} req
		 * @param {net.Socket} socket
		 * @param {Buffer} head
		 */
		tunnel: async (req, socket, head) => {
			const ctx = { req, socket, head };
			try {
				await proxy.protect(ctx); // 1. 挂载错误处理器
				await proxy.authenticate(ctx); // 2. 代理身份认证
				await hook.connect.before(ctx); // 3. 执行连接前置钩子
				await proxy.filter(ctx); // 4. 黑白名单过滤
				await proxy.log(ctx); // 5. 记录请求日志
				await proxy.tunnel.connect(ctx); // 6. 连接到目标服务器
				await proxy.tunnel.dock(ctx); // 7. 与客户端握手并获取SNI
				await hook.negotiate.before(ctx); // 8. 执行协商钩子
				await proxy.tunnel.pipe(ctx); // 9. 建立双向数据管道
			} catch (error) {
				proxy.tunnel.close(ctx); // 捕获异常并关闭连接
			}
		},
	},

	/**
	 * 强制关闭/销毁socket连接
	 * @param {net.Socket} socket
	 */
	abort: (socket) => {
		if (socket) socket.end();
		if (socket && !socket.destroyed) socket.destroy();
	},

	/**
	 * 为请求、响应和socket挂载统一的错误处理器
	 * @param {object} ctx
	 */
	protect: (ctx) => {
		const { req, res, socket } = ctx;
		if (req) req.on('error', () => proxy.abort(req.socket, 'req'));
		if (res) res.on('error', () => proxy.abort(res.socket, 'res'));
		if (socket) socket.on('error', () => proxy.abort(socket, 'socket'));
	},

	/**
	 * 记录请求日志
	 * @param {object} ctx
	 */
	log: (ctx) => {
		const { req, socket, decision } = ctx;
		// 核心修改：使用 new URL() 替换 url.parse()
		const url = new URL(req.url, `http${req.socket.encrypted ? 's' : ''}://${req.headers.host || 'localhost'}`);
		if (socket) {
			logger.debug({ decision, url: req.url }, `TUNNEL`);
		} else {
			logger.debug(
				{
					decision,
					host: url.host,
					encrypted: req.socket.encrypted,
				},
				`MITM${req.socket.encrypted ? ' (ssl)' : ''}`
			);
		}
	},

	/**
	 * 代理身份认证
	 * @param {object} ctx
	 */
	authenticate: (ctx) => {
		const { req, res, socket } = ctx;
		const credential = Buffer.from(
			(req.headers['proxy-authorization'] || '').split(/\s+/).pop() || '',
			'base64'
		).toString();
		if ('proxy-authorization' in req.headers)
			delete req.headers['proxy-authorization'];

		if (
			server.authentication &&
			credential !== server.authentication &&
			(socket || req.url.startsWith('http://'))
		) {
			if (socket)
				socket.write(
					'HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic realm="realm"\r\n\r\n'
				);
			else
				res.writeHead(407, {
					'proxy-authenticate': 'Basic realm="realm"',
				});
			return Promise.reject((ctx.error = 'authenticate'));
		}
	},

	/**
	 * 黑白名单过滤
	 * @param {object} ctx
	 */
	filter: (ctx) => {
		if (ctx.decision || ctx.req.local) return;
		// 核心修改：使用 new URL() 替换 url.parse()
		const url = new URL(ctx.req.url, `http${ctx.socket ? 's' : ''}://dummy-base`);
		const match = (pattern) =>
			url.href.search(new RegExp(pattern, 'g')) !== -1;
		try {
			const allow = server.whitelist.some(match);
			const deny = server.blacklist.some(match);
			if (!allow && deny) {
				return Promise.reject((ctx.error = 'filter'));
			}
		} catch (error) {
			ctx.error = error;
		}
	},

	/**
	 * HTTP请求的具体实现
	 */
	mitm: {
		request: (ctx) =>
			new Promise((resolve, reject) => {
				if (ctx.decision === 'close')
					return reject((ctx.error = ctx.decision));
				const { req } = ctx;
				if (isHost(req.url, 'bilivideo.com')) {
					req.headers['referer'] = 'https://www.bilibili.com/';
					req.headers['user-agent'] = 'okhttp/3.4.1';
				}
				// 核心修改：使用 new URL() 替换 url.parse()
				const url = new URL(req.url);
				const options = request.configure(req.method, url, req.headers);
				ctx.proxyReq = request
					.create(url)(options)
					.on('response', (proxyRes) =>
						resolve((ctx.proxyRes = proxyRes))
					)
					.on('error', (error) => reject((ctx.error = error)));
				req.readable
					? req.pipe(ctx.proxyReq)
					: ctx.proxyReq.end(req.body);
			}),
		response: (ctx) => {
			const { res, proxyRes } = ctx;
			proxyRes.on('error', () =>
				proxy.abort(proxyRes.socket, 'proxyRes')
			);
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.readable ? proxyRes.pipe(res) : res.end(proxyRes.body);
		},
		close: (ctx) => {
			proxy.abort(ctx.res.socket, 'mitm');
		},
	},

	/**
	 * HTTPS隧道的具体实现
	 */
	tunnel: {
		connect: (ctx) =>
			new Promise((resolve, reject) => {
				if (ctx.decision === 'close')
					return reject((ctx.error = ctx.decision));
				const { req } = ctx;
				// 核心修改：使用 new URL() 替换 url.parse()
				const url = new URL('https://' + req.url);
				if (global.proxy && !req.local) {
					// 通过上游代理连接
					const options = request.configure(
						req.method,
						url,
						req.headers
					);
					request
						.create(global.proxy)(options) // 注意这里 create 的参数是 global.proxy
						.on('connect', (_, proxySocket) =>
							resolve((ctx.proxySocket = proxySocket))
						)
						.on('error', (error) => reject((ctx.error = error)))
						.end();
				} else {
					// 直接连接
					const proxySocket = net
						.connect(
							url.port || 443,
							request.translate(url.hostname)
						)
						.on('connect', () =>
							resolve((ctx.proxySocket = proxySocket))
						)
						.on('error', (error) => reject((ctx.error = error)));
				}
			}),
		dock: (ctx) =>
			new Promise((resolve) => {
				const { req, head, socket } = ctx;
				socket
					.once('data', (data) =>
						resolve((ctx.head = Buffer.concat([head, data])))
					)
					.write(
						`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`
					);
			})
				.then((data) => (ctx.socket.sni = sni(data)))
				.catch((e) => e && logger.error(e)),
		pipe: (ctx) => {
			if (ctx.decision === 'blank')
				return Promise.reject((ctx.error = ctx.decision));
			const { head, socket, proxySocket } = ctx;
			proxySocket.on('error', () =>
				proxy.abort(ctx.proxySocket, 'proxySocket')
			);
			proxySocket.write(head);
			socket.pipe(proxySocket);
			proxySocket.pipe(socket);
		},
		close: (ctx) => {
			proxy.abort(ctx.socket, 'tunnel');
		},
	},
};

// --- 服务器创建与启动 ---

// 读取SSL证书文件
const cert = process.env.SIGN_CERT || path.join(__dirname, '..', 'server.crt');
const key = process.env.SIGN_KEY || path.join(__dirname, '..', 'server.key');
const options = {
	key: fs.readFileSync(key),
	cert: fs.readFileSync(cert),
};

// 创建HTTP和HTTPS服务器实例
const server = {
	http: http
		.createServer()
		.on('request', proxy.core.mitm)
		.on('connect', proxy.core.tunnel),
	https: https
		.createServer(options)
		.on('request', proxy.core.mitm)
		.on('connect', proxy.core.tunnel),
};

// 初始化黑白名单和认证信息
server.whitelist = [];
server.blacklist = ['://127\\.\\d+\\.\\d+\\.\\d+', '://localhost'];
server.authentication = null;

// 导出 server 对象，供 app.js 使用
module.exports = server;