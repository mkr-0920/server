const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const track = async (info) => {
    const baseUrl = process.env.LX_API_URL || '';
    const url = `${baseUrl}/url?source=wy&songId=${info.id}&quality=master`;

    const headers = {};
    const apiKey = process.env.LX_API_KEY || '';
    if (apiKey) {
        headers['X-Request-Key'] = apiKey;
    }

    try {
        const response = await request('GET', url, headers);
        const jsonBody = await response.json();
        
        if (jsonBody.code === 200 && jsonBody.url) {
            return jsonBody.url;
        } else {
            const errorMessage = jsonBody.message || 'API返回了错误或无效数据';
            throw new Error(errorMessage);
        }
    } catch (error) {
        console.error("调用网易云API失败:", error);
        throw error;
    }
};

const cs = getManagedCacheStorage('provider/pyncmd');
const check = async (info) => {
    return cs.cache(info, () => track(info));
};

module.exports = { check };
