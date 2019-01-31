const CacheBuilder   = require('smart-redis').CacheBuilder;
const DEFAULT_LOGGER = require('log4js').getLogger('sample-customized-logger');
DEFAULT_LOGGER.level = 'debug';

function sampleDataFetchingFn() {
    return [{
        'id': "id1",
        'value': 'value1'
    },
        {
            'id': "id2",
            'value': 'value2'
        },
    ]
}

async function initCacheBuilder() {
    let cacheBuilder = await CacheBuilder({
        redisOption: {
            host: 'localhost',
            port: 6379,
            password: ''
        },
        masterCacheKey: 'sample-key',
        logging: {
            enable: true,
            logger: DEFAULT_LOGGER
        }
    });

    cacheBuilder.register({
        dataFetchingFn: sampleDataFetchingFn,
        cacheKeys: ['sample-key-list', 'sample-key-hash'],
        redisDataTypes: ['list', 'hash'],
        refreshInterval: 100,
        idProp: 'id',
        name: 'sampleCacheName'
    });
}

initCacheBuilder();