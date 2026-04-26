const crypto = require('../../crypto');

module.exports = {
	before: (ctx) => {
		const { req } = ctx;
		if (!ctx.netease && req.url.includes('package')) {
			try {
				const data = req.url.split('package/').pop().split('/');
				const decodedUrl = new URL(crypto.base64.decode(data[0]));
				req.url = decodedUrl.href;
				req.headers['host'] = decodedUrl.hostname;
				req.headers['cookie'] = '';
				ctx.package = { id: data[1].replace(/\.\w+/, '') };
				ctx.decision = 'proxy';
			} catch (error) {
				ctx.decision = 'close';
			}
		}
	},
	after: async (ctx) => {
		const { req, proxyRes, package: pkg } = ctx;
		if (pkg) {
			if (new Set([201, 301, 302, 303, 307, 308]).has(proxyRes.statusCode)) {
                const request = require('../../request');
				const response = await request(
					req.method,
					new URL(proxyRes.headers.location, req.url).href,
					req.headers
				);
				ctx.proxyRes = response;
			} else if (/p\d+c*\.music\.126\.net/.test(req.url)) {
				proxyRes.headers['content-type'] = 'audio/*';
			}
		}
	}
};
