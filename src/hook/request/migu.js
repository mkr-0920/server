module.exports = {
	after: (ctx) => {
		const { req, proxyRes } = ctx;
		if (
			req.headers.host === 'tyst.migu.cn' &&
			proxyRes.headers['content-range'] &&
			proxyRes.statusCode === 200
		) {
			proxyRes.statusCode = 206;
		}
	}
};
