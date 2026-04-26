const crypto = require('../../crypto');
const request = require('../../request');
const { logScope } = require('../../logger');
const logger = logScope('hook:crypto');

module.exports = {
	before: async (ctx, hook) => {
		const { req } = ctx;
		const url = new URL(req.url);
		
		if (
			[url.hostname, req.headers.host].some((host) => hook.target.host.has(host)) &&
			req.method === 'POST' &&
			(url.pathname.startsWith('/eapi/') || url.pathname.startsWith('/api/linux/forward'))
		) {
			try {
				const body = await request.read(req);
				req.body = body;
				if (body) {
					const netease = {};
					netease.pad = (body.match(/%0+$/) || [''])[0];
					if (url.pathname === '/api/linux/forward') {
						netease.crypto = 'linuxapi';
					} else if (url.pathname.startsWith('/eapi/')) {
						netease.crypto = 'eapi';
					}

					try {
						let data;
						switch (netease.crypto) {
							case 'linuxapi':
								data = JSON.parse(crypto.linuxapi.decrypt(Buffer.from(body.slice(8, body.length - netease.pad.length), 'hex')).toString());
								netease.path = new URL(data.url).pathname;
								netease.param = data.params;
								break;
							case 'eapi':
								data = crypto.eapi.decrypt(Buffer.from(body.slice(7, body.length - netease.pad.length), 'hex')).toString().split('-36cd479b6b5-');
								netease.path = data[0];
								netease.param = JSON.parse(data[1]);
								netease.e_r = (netease.param.e_r === 'true' || netease.param.e_r === true);
								break;
						}
					} catch (e) {
						logger.error(e, `Failed to decrypt request body for ${req.url}.`);
					}

					netease.path = (netease.path || '').replace(/\/\d*$/, '');
					ctx.netease = netease;
				}
			} catch (error) {
				logger.error(error, `An error occurred in crypto.before.`);
			}
		}
	},
	after: async (ctx, hook) => {
		const { req, proxyRes, netease } = ctx;
		if (
			netease &&
			hook.target.path.has(netease.path) &&
			proxyRes.statusCode === 200
		) {
			try {
				let buffer = await request.read(proxyRes, true);
				if (buffer.length) {
					proxyRes.body = buffer;
				} else {
					throw undefined;
				}

				const patch = (string) =>
					string.replace(
						/([^\\]"\s*:\s*)(\d{16,})(\s*[}|,])/g,
						'$1"$2L"$3'
					); // for js precision

				if (netease.e_r) {
					netease.jsonBody = JSON.parse(
						patch(crypto.eapi.decrypt(buffer).toString())
					);
				} else {
					netease.jsonBody = JSON.parse(patch(buffer.toString()));
				}
			} catch (error) {
				if (error) {
					logger.error(
						error,
						`A error occurred in crypto.after when decrypting ${req.url}.`
					);
				}
			}
		}
	}
};
