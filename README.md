# smart-redis

Redis cache which automatically build and refresh itself.

## Motivation
There is data which take really long time to fetch from sources (e.g: reporting query, analytics query) but user need fast response time and always be available. The solution is to create a cache that can build and refresh itself in the background.

If this sounds like your problem then it is exactly what you're looking for.

## Features
1. Auto build and update cache on specified interval.
2. Zero downtime cache refresh.
3. Support multiple application instances.

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

## How it work?

smart-redis natively support multi application instances deployment, in order for it to work correctly, each instance has to be deployed in a separated host (VM or docker container)  

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
    - it will go to sleep and periodically check for master aliveness:
        - If master is alive, go to sleep
        - If master is not alive, try to become master.
    - it also listen to master key deletion event. If master key got deleted, all non-master instances will try to become master.

## TODO
- better connection refused error handling
- add support for custom parameter to the dataFetchingFn function.
- add support for **set** data type.
- add validation for hash idProp option.
- encapsulate private function and constructor
