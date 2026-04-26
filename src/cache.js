const { EventEmitter } = require('events');
const { logScope } = require('./logger');

const logger = logScope('cache');

const CacheStorageEvents = {
	CLEANUP: 'cs@cleanup',
};

/**
 * @typedef {{data: any, expireAt: Date}} CacheData
 */

/**
 * A cache storage for storing any type of data.
 */
class CacheStorage extends EventEmitter {
	/**
	 * @type {string}
	 */
	id = 'Default Cache Storage';

	/**
	 * @type {Map<any, CacheData>}
	 * @readonly
	 */
	cacheMap = new Map();

	aliveDuration = 30 * 60 * 1000; // will expire after 30 minutes.

	/**
	 * Construct a cache storage.
	 *
	 * @param {string?} id The ID of this cache storage.
	 */
	constructor(id) {
		super();

		// Set the ID of this cache storage.
		if (id) this.id = id;

		// Run background cleanup task every 10 minutes to prevent memory leak
		// from expired caches that are never accessed again.
		this.cleanupInterval = setInterval(() => {
			this.removeExpiredCache();
		}, 10 * 60 * 1000).unref();
	}

	/**
	 * Get the absolute UNIX timestamp the cache will be ended.
	 * @return {number}
	 * @constructor
	 */
	get WillExpireAt() {
		return Date.now() + this.aliveDuration;
	}

	/**
	 * Get the context for logger().
	 *
	 * @param {Record<string, string>?} customContext The additional context.
	 * @return {Record<string, string>}
	 * @private
	 */
	getLoggerContext(customContext = {}) {
		return {
			...customContext,
			cacheStorageId: this.id,
		};
	}

	/**
	 * Remove the expired cache.
	 */
	removeExpiredCache() {
		logger.debug(
			this.getLoggerContext(),
			'Background task: Cleaning up the expired caches...'
		);
		const now = Date.now();
		this.cacheMap.forEach((cachedData, key) => {
			if (cachedData.expireAt <= now) this.cacheMap.delete(key);
		});
	}

	/**
	 * Cache the response.
	 *
	 * @template T
	 * @param {any} key the unique key of action to be cached.
	 * @param {() => Promise<T>} action the action to do and be cached.
	 * @param {number=} expireAt customize the expireAt of this key.
	 * @return {Promise<T>}
	 */
	async cache(key, action, expireAt) {
		// Disable the cache when the NO_CACHE = true.
		if (process.env.NO_CACHE === 'true') {
			return action();
		}

		// Check if we have cached it before.
		// If true, we return the cached value.
		const cachedData = this.cacheMap.get(key);
		const now = Date.now();

		// Object.toString() can't bring any useful information,
		// we show "Something" instead.
		const logKey = typeof key === 'object' ? 'Something' : key;

		// Get the logger context with getLoggerContext
		const logCtx = this.getLoggerContext({
			logKey,
		});

		// Lazy expiration: Check if the cached data is expired when accessing it.
		if (cachedData) {
			if (cachedData.expireAt > now) {
				logger.debug(logCtx, `${logKey} hit!`);
				return cachedData.data;
			} else {
				// The cache is expired, remove it.
				logger.debug(logCtx, `${logKey} expired, removing from cache.`);
				this.cacheMap.delete(key);
			}
		}

		// Cache the response of action() and
		// register into our cache map.
		logger.debug(
			logCtx,
			`${logKey} did not hit. Storing the execution result...`
		);

		const sourceResponse = await action();
		this.cacheMap.set(key, {
			data: sourceResponse,
			expireAt: new Date(expireAt || this.WillExpireAt),
		});
		return sourceResponse;
	}
}

/**
 * The group which aimed to manage all CacheStorage and
 * call the common method such as `removeExpiredCache()`.
 */
class CacheStorageGroup {
	/**
	 * @type {CacheStorageGroup | undefined}
	 */
	static instance = undefined;

	/** @type {Set<CacheStorage>} */
	cacheStorages = new Set();

	/** @private */
	constructor() {}

	/**
	 * @return {CacheStorageGroup}
	 */
	static getInstance() {
		if (!CacheStorageGroup.instance)
			CacheStorageGroup.instance = new CacheStorageGroup();

		return CacheStorageGroup.instance;
	}

	cleanup() {
		this.cacheStorages.forEach((storage) => storage.removeExpiredCache());
	}
}

/**
 * The CacheStorageGroup instance that is used internally.
 *
 * Don't export it!
 *
 * @type {CacheStorageGroup}
 */
const csgInstance = CacheStorageGroup.getInstance();

/**
 * Get the managed CacheStorage.
 *
 * “Managed” means that this CacheStorage has been
 * added to CacheStorageGroup.
 *
 * @param {string} id
 * @return {CacheStorage}
 */
function getManagedCacheStorage(id) {
	const cs = new CacheStorage(id);
	csgInstance.cacheStorages.add(cs);
	return cs;
}

module.exports = {
	CacheStorage,
	CacheStorageEvents,
	CacheStorageGroup,
	getManagedCacheStorage,
};
