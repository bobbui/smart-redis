const {promisify}    = require('util');
const _              = require("lodash");
const redis          = require("redis");
const exitHook       = require('exit-hook');
const uuidv1         = require('uuid/v1');
const async          = require('async');
const asyncRedis     = require("async-redis");
const ping           = require('ping');
const asyncEachLimit = promisify(async.eachLimit);

const CHANNEL_REGEX           = new RegExp('^__keyspace@\\d+__:([\\w_]*)$');
const DEFAULT_LOGGER          = require('log4js').getLogger('smart-redis');
DEFAULT_LOGGER.level          = 'debug';
const OK_RESPONSE             = 'OK';
const CACHE_MASTER_KEY_PREFIX = 'CACHE_MASTER_KEY';

/**
 * Main class for smart-redis module
 */
class CacheBuilder {
    /**
     * entry point function to create CacheBuilder instance.
     * options:
     *
     *   - `redisOption`  option to initialize node_redis, see here for full detail: http://redis.js.org/#api-rediscreateclient
     *   - `masterCacheKey`  optional prefix for master key, if dont have multiple CacheBuilder instance, you can safely ignore it.
     *   - `logging`  optional logging option for debugging purpose
     *     logging.enable: whether enable debug logging, default is false
     *     logging.logger: customized logger accept log4j and winston instance, default is built-in log4js logger
     *
     * @param options
     * @return {Promise<CacheBuilder>}
     */
    static async build(options) {
        let cacheBuilder = new CacheBuilder(options);
        await cacheBuilder._init();
        return cacheBuilder;
    }

    /**
     * do not use this direct
     * @return {Promise<void>}
     */
    async _init() {
        let self = this;

        this._pubClient = await  this._getPubRedisClient();
        this._subClient = await this._getSubRedisClient();

        await this._tryToBecomeMaster();

        this._subClient.psubscribe('__keyspace@?__:CACHE_MASTER_KEY');
        this._subClient.on("pmessage", async function (pattern, channel, message) {
            let keyName = CHANNEL_REGEX.exec(channel)[1];
            if (keyName === self._masterCacheKey && (message === 'del' || message === 'expired')) {
                self._enableLogging && self._logger.info("❗❗❗ CACHE_MASTER_KEY gone, its time for me to become master, ha ha ha!");
                await self._tryToBecomeMaster();
            }
        });
        this._subClient.on("psubscribe", async function (pattern, count) {
            self._enableLogging && self._logger.info("❗❗❗ subcribed to " + pattern + ', count: ' + count);
        });
        this._subClient.on("punsubscribe", async function (pattern, count) {
            self._enableLogging && self._logger.info("❗❗❗ unsubcribed to " + pattern + ', count: ' + count);
        });

        exitHook(() => {
            try {
                this._enableLogging && this._logger.error('Something catastrophic happened, clean up before exit');
                if (self.isMaster) {
                    self._enableLogging && self._logger.info(`Is master, so release ${this._masterCacheKey} key`);
                    let noOfDeletedKey = this._pubClient.del(this._masterCacheKey);
                    self._enableLogging && self._logger.info(`${this._masterCacheKey} released ${JSON.stringify(noOfDeletedKey) }`);
                } else {
                    self._enableLogging && self._logger.info(`Is NOT master, NO need to release ${this._masterCacheKey} key`);
                }
                this._pubClient.quit((err) => {
                    self._enableLogging && self._logger.info("PUB redis_cache connection end!");
                });
                this._subClient.quit((err) => {
                    self._enableLogging && self._logger.info("SUB redis_cache connection end!");
                });
            } catch (e) {
                self._enableLogging && self._logger.error('xxxxxxx Error happened when try to clean up!');
                self._enableLogging && self._logger.error(e);
            }
        });
    }

    constructor(options) {
        this._redisOptions   = _.defaultTo(options.redisOption, {});
        this._masterCacheKey = CACHE_MASTER_KEY_PREFIX + _.defaultTo(options.masterCacheKey, '');
        this._functionCache  = {};
        this.isMaster        = false;
        if (_.has(options, 'logging')) {
            this._enableLogging = _.defaultTo(options.logging.enable, false);
            this._logger        = _.defaultTo(options.logging.logger, DEFAULT_LOGGER);
        } else {
            this._enableLogging = false;
            this._logger        = DEFAULT_LOGGER;
        }
    }

    async _getPubRedisClient() {
        let redisClient = await this._getRedisClient(`PUB REDIS`);
        redisClient.config("SET", "notify-keyspace-events", "Kg$lx");
        return redisClient;
    }

    async _getSubRedisClient() {
        return await this._getRedisClient(`SUB REDIS`);
    }

    async _getRedisClient(name) {
        let redisClientVar;
        try {
            let tempVar = redis.createClient(this._redisOptions);

            redisClientVar = asyncRedis.decorate(tempVar);
            let authResult = await redisClientVar.auth(this._redisOptions.password);
            if (authResult === OK_RESPONSE) {
                this._enableLogging && this._logger.info(`✅✅✅ ${name} AUTH successfully`);

                redisClientVar.on("error", (err) => {
                    this._enableLogging && this._logger.error(`😥😥😥 ${name} Can not connect to ${host}:${port}, CACHE IS NOT AVAILABLE!: ${err.message}`);
                });
                redisClientVar.on("ready", async (err) => {
                    this._enableLogging && this._logger.info(`✅✅✅ ${name} Connected to ${host}:${port}! `);
                });
                redisClientVar.on("end", async () => {
                    this._enableLogging && this._logger.error(`😥😥😥 ${name} ${host}:${port} Disconnected: ${err.message}`);
                    this._enableLogging && this._logger.error(err);
                });
                redisClientVar.on("reconnecting", async (config) => {
                    this._enableLogging && this._logger.error(`❗❗❗ ${name} ${host}:${port} Reconnecting: ${JSON.stringify(config) }`);
                    this._enableLogging && this._logger.error(config);
                });
            }
        } catch (err) {
            let msg = `😥😥😥 ${name} authentication error: ${err}`;
            this._enableLogging && this._logger.error(msg);
            throw new Error(msg);
        }

        return redisClientVar;
    }

    async _tryToBecomeMaster() {
        let self = this;
        try {
            let tryToBecomeMasterNode = await
                this._pubClient.set(this._masterCacheKey, require('os').hostname(), 'EX', 7200, 'NX');

            if (tryToBecomeMasterNode === OK_RESPONSE) {
                this.isMaster = true;
                this._enableLogging && this._logger.info('✅✅✅ Awesome! I have become cache loader master');

                if (!_.isNil(this._masterAlivenessCheckInterval)) {
                    clearInterval(this._masterAlivenessCheckInterval);
                }
            } else {
                this.isMaster = false;

                // try to ping the master host, if not alive, delete the key
                this._masterAlivenessCheckInterval = setInterval(async function () {
                    let masterHost = await self._pubClient.get(self._masterCacheKey);
                    self._enableLogging && self._logger.info(`Checking aliveness of master '${masterHost}' is DEAD, delete the master key to elect new master`);
                    ping.promise.probe(masterHost, {
                        timeout: 10,
                    }).then(async function (res) {
                        if (!res.alive) {
                            self._enableLogging && self._logger.info(`Master '${masterHost}' is DEAD, delete the master key to elect new master`);
                            await self._pubClient.del(self._masterCacheKey);
                        } else {
                            self._enableLogging && self._logger.info(`Master '${masterHost}' is ALIVE, no need to elect new master`);
                        }
                    });
                }, 5000);

                this._enableLogging && this._logger.info('❗❗❗ some other instance has become master, listening for its to be released');
            }
        } catch (e) {
            this._enableLogging && this._logger.error(`😥😥 Error happen when tried to become master ${e.message}: ${e.stack}`)
        }
    }

    async _buildCacheByFn(cacheName, dataFetchingFn, cacheKeys, redisDataTypes, idProp) {
        if (!this.isMaster) {
            this._enableLogging && this._logger.info(`❗ Im not master, skip cache building!`);
            return;
        }

        try {
            let data = await
                dataFetchingFn();

            this._enableLogging && this._logger.info(`✅ buildCacheByFn ${cacheName}: Successfully retrieve data from '${dataFetchingFn.name}'`);
            for (let i = 0; i < cacheKeys.length; i++) {
                const cacheKey = cacheKeys[i];
                const dataType = redisDataTypes[i];
                this._enableLogging && this._logger.info(`❗ Start building cache '${cacheKeys}'`);
                let temporaryKey = uuidv1();

                //put into a temporary key
                if (dataType === 'string') {
                    let s = JSON.stringify(data);

                    this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: Start building cache '${cacheKey}' with type '${dataType}' using temporary key '${temporaryKey}'`);
                    this._pubClient.hset(temporaryKey, s);
                    await
                        this._pubClient.rename(temporaryKey, cacheKey);

                } else if (dataType === 'list') {
                    if (!_.isArrayLikeObject(data)) {
                        this._enableLogging && this._logger.error(`buildCacheByFn ${cacheName}: function should return an array, cache is not refreshed!`);
                        return;
                    }
                    let reverseData     = _.reverse(data);
                    let stringifiedData = reverseData.map((item) => JSON.stringify(item));
                    this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: Start building cache '${cacheKeys}' with type '${dataType}' using temporary key '${temporaryKey}'`);
                    let listLength = await
                        this._pubClient.lpush(temporaryKey, ...stringifiedData);
                    await
                        this._pubClient.rename(temporaryKey, cacheKey);
                    this._enableLogging && this._logger.info(`Successfully inserted ${listLength} into list ${temporaryKey}`);
                } else if (dataType === 'set') {
                    throw Error("set is not supported yet");
                } else if (dataType === 'hash') {
                    if (!_.isObjectLike(data)) {
                        this._enableLogging && this._logger.error(` buildCacheByFn ${cacheName}: data should should be an object like entity, CACHE ${cacheKey} IS NOT REFRESHED!`);
                    }
                    let error = await
                        asyncEachLimit(data, 10, async item => {
                            let s1 = JSON.stringify(item);
                            this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: set hash ${cacheKey} key '${item[idProp]}'`);
                            this._pubClient.hset(cacheKey, item[idProp], s1);
                        });
                    if (!_.isNil(error))
                        throw Error(error);
                }
                this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: Rename cache key '${temporaryKey}' to '${cacheKey}'`);
                //rename temp key to destination key
                this._enableLogging && this._logger.info(`✅ buildCacheByFn ${cacheName}: Done building cache '${cacheKey}'`);
            }
        } catch (e) {
            this._enableLogging && this._logger.error(`😥😥 Error happen when tried to build cache ${cacheKeys}: ${e.stack}`);
            throw Error(e);
        }
    }

    /**
     * register a new cache
     * options:
     *
     *    - dataFetchingFn function to fetch data,
     *    - cacheKeys array of key strings,
     *    - redisDataTypes array of data type corresponding to the aforementioned array of keys, only ['hash', 'list', 'string'] are supported
     *    - refreshInterval interval to refresh,
     *    - idProp property name to extract key use for hash data structure
     *
     * @returns void
     * @param options
     *
     * @return {string}: unique cache name will be auto generated if not passed
     */
    async register(options) {
        let self = this;

        let {dataFetchingFn, cacheKeys, redisDataTypes, refreshInterval, idProp, name} = options;

        if (!_.isFunction(dataFetchingFn)) {
            throw Error('dataFetchingFn need to be function')
        }
        if (!_.isArrayLike(cacheKeys) || !_.isArrayLike(redisDataTypes)) {
            throw Error('cacheKeys and redisDataTypes has to be an array')
        }
        if (!_.every(cacheKeys, _.isString)) {
            throw Error('cacheKeys need to contains only string')
        }
        if (!_.every(redisDataTypes, type => {
            return _.indexOf(['hash', 'string', 'list'], type) >= 0;
        })) {
            throw Error('redisDataTypes only allow [\'hash\', \'string\', \'list\']')
        }

        if (_.size(cacheKeys) !== _.size(redisDataTypes)) {
            throw Error('cacheKeys and redisDataTypes has to be same size.')
        }

        let uniq = _.uniq(cacheKeys);
        if (uniq.length < cacheKeys.length) {
            throw Error('cacheKeys need to contains all unique values.')
        }

        if (!_.isNumber(refreshInterval) || refreshInterval <= 0) {
            throw Error('refreshInterval has to be a positive number')
        }

        if (_.isEmpty(name)) {
            name = uuidv1();
        }

        this._enableLogging && this._logger.info(`Start build cache for the first time: '${name}'`);

        this._functionCache[name] = options;

        await this._buildCacheByFn(name, dataFetchingFn, cacheKeys, redisDataTypes, idProp);

        let intervalId = setInterval(function () {
            self._buildCacheByFn(name, dataFetchingFn, cacheKeys, redisDataTypes, idProp);
        }, refreshInterval * 1000);

        this._functionCache[name]['intervalId'] = intervalId;

        return name;
    }
}

exports.CacheBuilder = CacheBuilder.build;