const { logScope } = require('../../logger');
const logger = logScope('hook:vip');

const ENABLE_LOCAL_VIP = ['true', 'cvip', 'svip'].includes(
	(process.env.ENABLE_LOCAL_VIP || '').toLowerCase()
);
const ENABLE_LOCAL_SVIP =
	(process.env.ENABLE_LOCAL_VIP || '').toLowerCase() === 'svip';
const LOCAL_VIP_UID = (process.env.LOCAL_VIP_UID || '')
	.split(',')
	.map((str) => parseInt(str, 10))
	.filter((num) => !Number.isNaN(num));

module.exports = {
	after: (ctx, hook) => {
		const { proxyRes, netease } = ctx;
		if (
			netease &&
			hook.target.path.has(netease.path) &&
			proxyRes.statusCode === 200 &&
			netease.jsonBody &&
			ENABLE_LOCAL_VIP
		) {
			const vipPath = '/api/music-vip-membership/client/vip/info';
			if (
				netease.path === '/batch' ||
				netease.path === '/api/batch' ||
				netease.path === vipPath
			) {
				const info =
					netease.path === vipPath
						? netease.jsonBody
						: netease.jsonBody[vipPath];
				const defaultPackage = {
					iconUrl: null,
					dynamicIconUrl: null,
					isSign: false,
					isSignIap: false,
					isSignDeduct: false,
					isSignIapDeduct: false,
				};
				const vipLevel = 7; // ? months
				if (
					info &&
					info.data &&
					(LOCAL_VIP_UID.length === 0 ||
						LOCAL_VIP_UID.includes(info.data.userId))
				) {
					try {
						const nowTime =
							info.data.now || new Date().getTime();
						const expireTime = nowTime + 31622400000;
						info.data.redVipLevel = vipLevel;
						info.data.redVipAnnualCount = 1;

						info.data.musicPackage = {
							...defaultPackage,
							...info.data.musicPackage,
							vipCode: 230,
							vipLevel,
							expireTime,
						};

						info.data.associator = {
							...defaultPackage,
							...info.data.associator,
							vipCode: 100,
							vipLevel,
							expireTime,
						};

						if (ENABLE_LOCAL_SVIP) {
							info.data.redplus = {
								...defaultPackage,
								...info.data.redplus,
								vipCode: 300,
								vipLevel,
								expireTime,
							};

							info.data.albumVip = {
								...defaultPackage,
								...info.data.albumVip,
								vipCode: 400,
								vipLevel: 0,
								expireTime,
							};
						}

						if (netease.path === vipPath)
							netease.jsonBody = info;
						else netease.jsonBody[vipPath] = info;
					} catch (error) {
						logger.debug(
							{ err: error },
							'Unable to apply the local VIP.'
						);
					}
				}
			}
		}
	}
};
