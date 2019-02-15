# smart-redis

Redis cache which automatically build and refresh itself.

## Motivation
There is data which take really long time to fetch from sources (e.g: reporting query, analytics query) but user need fast response time and always be available. The solution is to create a cache that can build and refresh itself in the background.

If this sounds like your problem then it is exactly what you're looking for.

## Features
1. Auto build and update cache on specified interval.
2. Zero downtime cache refresh.
3. Support multiple application instances.

This library has been used in production for few months, but use at your own risk.

## Usage

### Install
```bash
npm install smart-redis --save
```
or
```bash
yarn add smart-redis
```
### init

```javascript
const CacheBuilder   = require('smart-redis').CacheBuilder;
let cacheBuilder = await CacheBuilder.build({
    redisOption: {
        host: 'localhost',
        port: 6379,
        password: ''
    },
    masterCacheKey: 'sample-key'
});
```

### cache register
```javascript
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
cacheBuilder.register({
    dataFetchingFn: sampleDataFetchingFn,  // 
    cacheKeys: ['sample-key-list', 'sample-key-hash'],
    redisDataTypes: ['list', 'hash'],
    refreshInterval: 100,
    idProp: 'id',
    name: 'sampleCacheName'
});
```
cache should be built on the redis:
```bash
127.0.0.1:6379> keys *
1) "CACHE_MASTER_KEYsample-key"
2) "sample-key-hash"
3) "sample-key-list"
127.0.0.1:6379> lrange sample-key-list 0 1
1) "{\"id\":\"id1\",\"value\":\"value1\"}"
2) "{\"id\":\"id2\",\"value\":\"value2\"}"
127.0.0.1:6379> hgetall sample-key-hash
1) "id2"
2) "{\"id\":\"id2\",\"value\":\"value2\"}"
3) "id1"
4) "{\"id\":\"id1\",\"value\":\"value1\"}"
127.0.0.1:6379>
```

see **lib/sample.js** for full example.

## API references

1. **CacheBuilder.build(options?): Promise<CacheBuilder>**
entry point function to create CacheBuilder instance.
options parameter:
- redisOption: option to initialize node_redis, see here for full detail: http://redis.js.org/#api-rediscreateclient
- masterCacheKey: optional prefix for master key, if dont have multiple CacheBuilder instance, you can safely ignore it.
- logging: optional logging option for debugging purpose
- logging.enable: whether enable debug logging, default is false
- logging.logger: customized logger accept log4j and winston instance, default is built-in log4js logger
- masterAliveCheck: whether to perform master alive check by ping hostname

2. **CacheBuilder.register(options): string**
function to register a new cache
options parameter:
- name: cache builder instance name, if not pass an unique name will be generated, should contains only alphanumeric, _ or -
- dataFetchingFn: function to fetch data. 'list' data type expects an array, 'hash' data type expects an array of object.
- cacheKeys: array of key strings,
- redisDataTypes: array of data type corresponding to the aforementioned array of keys, only ['hash', 'list', 'string'] are supported
- refreshInterval: interval to refresh,
- idProp: property name to extract key use for hash data structure  
Returns: unique cache name will be auto generated if not passed

## How it work?

smart-redis natively support multi application instances deployment

### Cache building and refreshing
0. Only master instance can build and refresh cache.
1. Application can register a cache by provide a function to fetch the data, a cache key and a refresh interval.
2. Cache will be built immediately upon registered and after each time specified refresh interval elapsed.
    1. **smart-redis** using the function to fetch the data, returned data is stored into cache
    2. **smart-redis** stored fetched data into cache corresponding to the specified data type
    3. go to sleep

### Master election
Master instance is the application instance that responsible for cache building and refreshing. Only one application instance can become master.  
When an application with **smart-redis** start, it will try to become a master instance
1. If it becomes master: there will be a master key stored in redis pointing to this instance. cache will be built and refreshed from this instance
    - If this instance is terminated (by exit, SIGINT, or SIGTERM signal), it will release it master key.
2. If it couldn't become master:
    - it will go to sleep and periodically check for master aliveness (if enabled):
        - If master is alive, go to sleep
        - If master is not alive, try to become master.
    - it also listen to master key deletion event. If master key got deleted, all non-master instances will try to become master.

## TODO
- better connection refused error handling
- add support for custom parameter to the dataFetchingFn function.
- add support for **set** data type.
- add validation for hash idProp option has to be string
- encapsulate private function and constructor
- un-register, update existing cache instance
- add unit test
- bug fix: disconnect will render master key monitoring disabled
