const BLOCK_ADS = (process.env.BLOCK_ADS || '').toLowerCase() === 'true';
const DISABLE_UPGRADE_CHECK =
	(process.env.DISABLE_UPGRADE_CHECK || 'true').toLowerCase() === 'true';

module.exports = {
	before: (ctx) => {
		const { netease } = ctx;
		if (netease && netease.path) {
			if (BLOCK_ADS && netease.path.startsWith('/api/ad')) ctx.decision = 'close';
			if (DISABLE_UPGRADE_CHECK && netease.path.match(/^\/api(\/v1)?\/(android|ios|osx|pc)\/(upgrade|version)/)) ctx.decision = 'close';
		}
	}
};
