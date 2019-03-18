const {promisify}    = require('util');
const _              = require("lodash");
const redis          = require("redis");
const exitHook       = require('exit-hook');
const uuidv1         = require('uuid/v1');
const async          = require('async');
const asyncRedis     = require("async-redis");
const ping           = require('ping');
const asyncEachLimit = promisify(async.eachLimit);

const CHANNEL_REGEX           = new RegExp('^__keyspace@\\d+__:([\\w_-]*)$');
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
     * options parameter:
     *
     *   - `redisOption`:  option to initialize node_redis, see here for full detail: http://redis.js.org/#api-rediscreateclient
     *   - `masterCacheKey`:  optional prefix for master key, if dont have multiple CacheBuilder instance, you can safely ignore it.
     *   - `logging`:  optional logging option for debugging purpose
     *     `logging.enable`: whether enable debug logging, default is false
     *     `logging.logger`: customized logger accept log4j and winston instance, default is built-in log4js logger
     *   - `masterAliveCheck`: whether to perform master alive check by ping hostname
     * @param options
     * @return {Promise<CacheBuilder>}
     */
    static async build(options) {
        let cacheBuilder = new CacheBuilder(options);
        await cacheBuilder._init();
        return cacheBuilder;
    }

    /**
     * do not use this directly, use build method instead
     * @return {Promise<void>}
     */
    async _init() {
        let self = this;

        this._pubClient = await this._getPubRedisClient();
        this._subClient = await this._getSubRedisClient();

        await this._tryToBecomeMaster();

        this._subClient.psubscribe('__keyspace@?__:' + this._masterCacheKey);

        //if master key is deleted, try to become master
        this._subClient.on("pmessage", async function (pattern, channel, message) {
            let keyName = CHANNEL_REGEX.exec(channel)[1];
            if (keyName === self._masterCacheKey && (message === 'del' || message === 'expired')) {
                self._enableLogging && self._logger.info("❗❗❗ CACHE_MASTER_KEY gone, its time for me to become master, he he he!");
                await self._tryToBecomeMaster();
            }
        });

        this._subClient.on("psubscribe", async function (pattern, count) {
            self._enableLogging && self._logger.info("❗❗❗ subcribed to " + pattern + ', count: ' + count);
        });
        this._subClient.on("punsubscribe", async function (pattern, count) {
            self._enableLogging && self._logger.info("❗❗❗ unsubcribed to " + pattern + ', count: ' + count);
        });

        this.registerExitHook(self);
    }

    registerExitHook(self) {
        exitHook(() => {
            try {
                this._logger.error('Something catastrophic happened, clean up before exit');
                if (self.isMaster) {
                    self._enableLogging && self._logger.info(`Is master, so release ${this._masterCacheKey} key`);
                    let noOfDeletedKey = this._pubClient.del(this._masterCacheKey);
                    self._enableLogging && self._logger.info(`${this._masterCacheKey} released ${JSON.stringify(noOfDeletedKey)}`);
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
                self._logger.error('xxxxxxx Error happened when try to clean up!');
                self._logger.error(e);
            }
        });
    }

    constructor(options) {
        this._redisOptions     = _.defaultTo(options.redisOption, {});
        this._masterCacheKey   = CACHE_MASTER_KEY_PREFIX + _.defaultTo(options.masterCacheKey, '');
        this._masterAliveCheck = _.defaultTo(options.masterAliveCheck, false);
        this._functionCache    = {};
        this.isMaster          = false;

        if (_.has(options, 'logging')) {
            this._enableLogging = _.defaultTo(options.logging.enable, false);
            this._logger        = _.defaultTo(options.logging.logger, DEFAULT_LOGGER);
        } else {
            this._enableLogging = false;
            this._logger        = DEFAULT_LOGGER;
        }
    }

    async _getPubRedisClient() {
        let self        = this;
        let redisClient = await this._getRedisClient(`PUB REDIS`);
        self._logger.info("PUB REDIS enable keyspace notification ");
        redisClient.config("SET", "notify-keyspace-events", "Kg$");
        return redisClient;
    }

    async _getSubRedisClient() {
        return await this._getRedisClient(`SUB REDIS`);
    }

    async _getRedisClient(name) {
        let redisClientVar;
        try {
            redisClientVar = asyncRedis.decorate(redis.createClient(this._redisOptions));

            let authResult = await redisClientVar.auth(this._redisOptions.password);
            if (authResult === OK_RESPONSE) {
                this._enableLogging && this._logger.info(`✅✅✅ ${name} AUTH successfully`);

                const host = this._redisOptions.host;
                const port = this._redisOptions.port;

                redisClientVar.on("error", (err) => {
                    self._logger.error(`😥😥😥 ${name} Can not connect to ${host}:${port}, CACHE IS NOT AVAILABLE!: ${err.message}`);
                });
                redisClientVar.on("ready", async (err) => {
                    this._enableLogging && this._logger.info(`✅✅✅ ${name} Connected to ${host}:${port}! `);
                });
                redisClientVar.on("end", async () => {
                    self._logger.error(`😥😥😥 ${name} ${host}:${port} Disconnected`);
                });
                redisClientVar.on("reconnecting", async (config) => {
                    self._logger.error(`❗❗❗ ${name} ${host}:${port} Reconnecting: ${JSON.stringify(config)}`);
                    self._logger.error(config);
                });
            }
        } catch (err) {
            let msg = `😥😥😥 ${name} authentication error: ${err}`;
            self._logger.error(msg);
            throw new Error(msg);
        }

        return redisClientVar;
    }

    async _tryToBecomeMaster() {
        try {
            let tryToBecomeMasterNode = await
                this._pubClient.set(this._masterCacheKey, require('os').hostname(), 'EX', 7200, 'NX');

            if (tryToBecomeMasterNode === OK_RESPONSE) {
                this.isMaster = true;
                this._enableLogging && this._logger.info('✅✅✅ Awesome! I have become cache loader master');

                if (this._masterAliveCheck) {
                    clearInterval(this._masterAlivenessCheckInterval);
                }
            } else {
                this._enableLogging && this._logger.info('❗❗❗ some other instance has become master, listening for its to be released');
                this.isMaster = false;

                if (this._masterAliveCheck) {
                    let self = this;

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
                    }, 60000); //every minutes
                }
            }
        } catch (e) {
            this._logger.error(`😥😥 Error happen when tried to become master ${e.message}: ${e.stack}`)
        }
    }

    async _buildCacheByFn(cacheName, dataFetchingFn, cacheKeys, redisDataTypes, idProp) {
        if (!this.isMaster) {
            this._enableLogging && this._logger.info(`❗ Im not master, skip cache building!`);
            return;
        }

        let data = await dataFetchingFn();

        this._enableLogging && this._logger.info(`✅ buildCacheByFn ${cacheName}: Successfully retrieve data from '${dataFetchingFn.name}'`);

        for (let i = 0; i < cacheKeys.length; i++) {
            const cacheKey = cacheKeys[i];
            const dataType = redisDataTypes[i];
            this._enableLogging && this._logger.info(`❗ Start building cache '${cacheKeys}'`);
            let temporaryCacheKey = uuidv1();

            //put into a temporary key
            switch (dataType) {
                case 'string':
                    this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: Start building cache '${cacheKey}' with type '${dataType}' using temporary key '${temporaryCacheKey}'`);

                    this._pubClient.set(temporaryCacheKey, JSON.stringify(data));
                    await this._pubClient.rename(temporaryCacheKey, cacheKey);
                    break;
                case 'list':
                    if (!_.isArrayLikeObject(data)) {
                        self._logger.error(`buildCacheByFn ${cacheName}: function should return an array, cache is not refreshed!`);
                        break;
                    }

                    this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: Start building cache '${cacheKeys}' with type '${dataType}' using temporary key '${temporaryCacheKey}'`);

                    let stringifiedDataArray = _.reverse(data).map((item) => JSON.stringify(item));
                    let listLength           = await this._pubClient.lpush(temporaryCacheKey, ...stringifiedDataArray);
                    await this._pubClient.rename(temporaryCacheKey, cacheKey);

                    this._enableLogging && this._logger.info(`Successfully inserted ${listLength} into list ${temporaryCacheKey}`);
                    break;
                case 'hash':
                    if (!_.isObjectLike(data)) {
                        self._logger.error(` buildCacheByFn ${cacheName}: data should should be an object like entity, CACHE ${cacheKey} IS NOT REFRESHED!`);
                        break;
                    }

                    let error = await asyncEachLimit(data, 10, async item => {
                        this._enableLogging && this._logger.info(`❗ buildCacheByFn ${cacheName}: set hash ${cacheKey} key '${item[idProp]}'`);
                        this._pubClient.hset(cacheKey, item[idProp], JSON.stringify(item));
                    });
                    if (!_.isNil(error))
                        throw Error(error);
                    break;
                default:
                    throw Error(`Unsupported data type '${dataType}'`);
            }
            this._enableLogging && this._logger.info(`✅ buildCacheByFn ${cacheName}: Done building cache '${cacheKey}'`);
        }
    }

    /**
     * function to register a new cache
     * options parameter:
     *
     *    - `name`: cache builder instance name, if not pass an unique name will be generated, should contains only alphanumeric, _ or -
     *    - `dataFetchingFn`: function to fetch data. 'list' data type expects an array, 'hash'  data type expects an array of object.
     *    - `cacheKeys`: array of key strings,
     *    - `redisDataTypes`: array of data type corresponding to the aforementioned array of keys, only ['hash', 'list', 'string'] are supported
     *    - `refreshInterval`: interval to refresh,
     *    - `idProp`: property name to extract key use for hash data structure
     *
     * @returns void
     * @param options
     *
     * @return {string}: unique cache name will be auto generated if not passed
     */
    async register(options) {
        this.validate(options);
        let {dataFetchingFn, cacheKeys, redisDataTypes, refreshInterval, idProp, name} = options;
        let self                                                                       = this;

        if (_.isEmpty(name)) {
            name = uuidv1();
        }

        this._enableLogging && this._logger.info(`Start build cache for the first time: '${name}'`);

        this._functionCache[name] = options;

        await this._buildCacheByFn(name, dataFetchingFn, cacheKeys, redisDataTypes, idProp);

        let intervalId = setInterval(function () {
            try {
                self._buildCacheByFn(name, dataFetchingFn, cacheKeys, redisDataTypes, idProp);
            } catch (e) {
                self._logger.error(`😥😥 Error happen when tried to build cache ${cacheKeys}: ${e.stack}`);
                throw Error(e);
            }
        }, refreshInterval * 1000);

        this._functionCache[name]['intervalId'] = intervalId;

        return name;
    }

    validate(options) {
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
        if (!_.isNil(idProp) && _.isString(idProp)) {
            throw Error('idProp has to be a string')
        }
    }
}

exports.CacheBuilder = CacheBuilder.build;