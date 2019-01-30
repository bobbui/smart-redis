# smart-redis

Build cache in Redis which automatically build and refresh itself.

## Motivation
There is data which take really long time to fetch from data sources (e.g: reporting query, analytics query) but user need fast response time and always be available. The solution is to create a cache that can refresh itself in the background once in a while.

If this sounds like your problem then it is exactly what you're looking for.

## Features
1. Auto build and update cache on specified interval.
2. Zero downtime cache refresh.
2. Support multiple application instances.

## How it work?
### Master election
1. smart-redis start, try to become a master instance.
    - If it become master: cache will be built and refreshed from this instance
    -

1. You provide a function to fetch the data, a cache key and a refresh interval.
2. smart-redis using the function to fetch the data, returned data is stored into cache
3

## Usage
