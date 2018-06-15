# Stubborn Fetch

Fetch wrapper with built in retry

---

[![styled with prettier](https://img.shields.io/badge/styled_with-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![Build Status](https://travis-ci.org/Quiq/stubborn-fetch.svg?branch=master)](https://travis-ci.org/Quiq/stubborn-fetch)

## Installation

```
npm i --save stubborn-fetch
```

or

```
yarn add stubborn-fetch
```

---

## Usage

```js
import StubbornFetch from 'stubborn-fetch';

new StubbornFetchRequest('/some/url').send().then(
  response => {
    // handle standard fetch response
  },
  error => {
    // handle standard fetch error
  },
);
```

---

## Parameters

### `url` - Url of the request to be made

```js
string;
```

### `fetchRequest` (optional) - Additional request [options](https://github.github.io/fetch/#options)

```js
Object = {
  method: 'get',
};
```

### `options` (optional) - Additional options

```js
Object = {
  timingFunction: 'exponential',
  maxDelay: 60000,
  debug: false,
  retries: 3,
  minimumStatusCodeForRetry: 400,
  retryOnNetworkFailure: false,
};
```

#### `timingFunction` - A function of the (form retryCount : delay in ms) to determine how long to wait between retries.

```js
string = 'exponential';
```

#### `maxDelay` - The maximum delay in ms between requests (upper bound on `timingFunction`)

```js
number;
```

#### `totalRequestTimeLimit` (optional) - The time limit across all retries of this request, after which the request will fail.

```js
number;
```

#### `retries` - How many times to attempt a request.

```js
number;
```

#### `minimumStatusCodeForRetry` - The lowest HTTP status code for which we will retry a request.

```js
number;
```

#### `unretryableStatusCodes` - An array of status code numbers for which we will never retry a request, even if it's above the `minimumStatusCodeForRetry`.

```js
Array<number>;
```

#### `retryOnNetworkFailure` - Whether we should retry a request when it fails due to a network issue, i.e. we did not get any response from server.

```js
boolean;
```

#### `maxErrors` (optional) - The maximum global error count we will tolerate across ALL requests. After this is hit, NO future requests will be sent.

```js
number;
```

#### `onError` - A function that will be called when a request attempt fails.

```js
(error: StubbornFetchError) => void
```

#### `shouldRetry` (optional) - Called for determining whether a retry attempt should occur. Takes precedence over other retry-related options.

```js
(error: StubbornFetchError, retries: number) => boolean;
```

#### `logger` (optional) - A class or object conforming to the `Logging` interface which we'll use for logging out request information and events.

```js
Logging = console;
```

## License

MIT
