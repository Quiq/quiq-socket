/* global jest */
import StubbornFetchError from '../error';
import 'isomorphic-fetch';
import fetchMock from 'fetch-mock';
import get from 'lodash/get';
import StubbornFetchRequest from '../QuiqSockets';

const getAllPathsInObject = (o: Object, currentPath: string = ''): Array<string> => {
  if (typeof o === 'object') {
    return Object.keys(o)
      .map(key => getAllPathsInObject(o[key], `${currentPath}${currentPath ? '.' : ''}${key}`))
      .reduce((flatArr, pathItem) => flatArr.concat(pathItem), []);
  }
  return [currentPath];
};

const subsetIsEqual = (superset, subset) => {
  const subsetPaths = getAllPathsInObject(subset);
  // eslint-disable-next-line no-restricted-syntax
  for (const path of subsetPaths) {
    if (get(superset, path) !== get(subset, path)) {
      return false;
    }
  }
  return true;
};

expect.extend({
  /**
   * Asserts that the received value is an instance of StubbornFetch error whose properties compose a superset of the passed object.
   * That is, for each path in the passed object, the path's value in the StubbornFetchError instance must be equal to that in the passed object.
   * It's similar to expect.objectContaining, but disregards structure of the objects as long as the value of each path are equivalent.
   */
  toBeStubbornFetchErrorWith(received, argument) {
    if (!(received instanceof StubbornFetchError)) {
      return {
        message: () => `Expected ${received} to be instance of StubbornFetchError`,
        pass: false,
      };
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const [key, value] of Object.entries(argument)) {
      if (!received[key] || !subsetIsEqual(received[key], value)) {
        return {
          message: () =>
            `Expected ${received}.${key} to contain as a subset \n` +
            ` ${this.utils.printExpected(value)}\n` +
            `Received:\n` +
            ` ${this.utils.printReceived(received[key])}`,
          pass: false,
        };
      }
    }

    return {
      message: () =>
        `expected ${received} not to be a StubbornFetchError instance with indicated properties`,
      pass: true,
    };
  },
  /**
   * Asserts that the received value is an instance of Response whose properties compose a superset of the passed object.
   * That is, for each path in the passed object, the path's value in the Response instance must be equal to that in the passed object.
   * It's similar to expect.objectContaining, but disregards structure of the objects as long as the value of each path are equivalent.
   */
  toBeResponseWith(received, argument) {
    if (!(received instanceof Response)) {
      return {
        message: () => `Expected ${received} to be instance of Response`,
        pass: false,
      };
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const [key, value] of Object.entries(argument)) {
      if (!received[key] || !subsetIsEqual(received[key], value)) {
        return {
          message: () =>
            `Expected ${received}.${key} to contain as a subset \n` +
            ` ${this.utils.printExpected(value)}\n` +
            `Received:\n` +
            ` ${this.utils.printReceived(received[key])}`,
          pass: false,
        };
      }
    }

    return {
      message: () =>
        `expected ${received} not to be a StubbornFetchError instance with indicated properties`,
      pass: true,
    };
  },
});

describe('StubbornFetch Service', () => {
  let options;
  let fetchRequest;
  let _originalSetTimeoutFunv, _originalDateNowFunv;
  const rejection = jest.fn();

  beforeAll(() => {
    fetchMock.mock('*', url => {
      if (url.indexOf('--fail--') !== -1) {
        return {
          status: 500,
          body: {status: 500, message: 'Uh oh!'},
        };
      } else if (url.indexOf('--fail400--') !== -1) {
        return {
          status: 402,
          body: {status: 402, message: 'Uh oh!'},
        };
      } else if (url.indexOf('--fail401--') !== -1) {
        return {
          status: 401,
          body: {status: 401, message: 'Uh oh!'},
        };
      } else if (url.indexOf('--fail429--') !== -1) {
        return {
          status: 429,
          body: {status: 429, message: 'Uh oh!'},
          headers: {'Retry-After': '2'},
        };
      } else if (url.indexOf('--fail429LongTime--') !== -1) {
        return {
          status: 429,
          body: {status: 429, message: 'Uh oh!'},
          headers: {'Retry-After': '360'},
        };
      } else if (url.indexOf('--fail429NoRetryAfterHeader--') !== -1) {
        return {
          status: 429,
          body: {status: 429, message: 'Uh oh!'},
        };
      }
      return {
        status: 200,
        body: {hello: 'world'},
      };
    });
  });

  beforeEach(() => {
    options = {
      debug: false,
      retries: 0,
    };
    fetchRequest = {};
  });

  afterEach(() => {
    // Reset StubbornFetch global error count
    StubbornFetchRequest.globalErrorCount = 0;
    StubbornFetchRequest.rateLimitedUntil = null;
    StubbornFetchRequest.enable();
    fetchMock.reset();
  });

  afterAll(() => {
    fetchMock.restore();
  });

  describe('dispatching request to isomorphic-fetch', () => {
    it('sends request with given URL', async () => {
      expect.assertions(1);

      await new StubbornFetchRequest('sendsReqWithGivenURL', fetchRequest, options).send();
      expect(fetchMock.called('sendsReqWithGivenURL', 'get')).toBe(true);
    });

    it('applies extended request data to fetch call', async () => {
      expect.assertions(1);

      fetchRequest = {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-Foo': 'bar',
        },
      };

      await new StubbornFetchRequest('sendsReqWithData', fetchRequest, options).send();

      expect(fetchMock.lastCall('sendsReqWithData', 'get')[1]).toEqual(
        expect.objectContaining(fetchRequest),
      );
    });

    it('uses correct method (POST)', async () => {
      expect.assertions(1);

      fetchRequest = {
        method: 'POST',
      };

      await new StubbornFetchRequest('sendsReqWithMethod', fetchRequest, options).send();

      expect(fetchMock.lastCall('sendsReqWithMethod', 'post')[1]).toEqual(
        expect.objectContaining(fetchRequest),
      );
    });
  });

  describe('Promise fulfillment', () => {
    beforeEach(() => {
      options.retries = 0;
    });

    it('rejects promise on failure', () => {
      expect.assertions(1);

      return expect(
        new StubbornFetchRequest('--fail--callsReject', fetchRequest, options).send(),
      ).rejects.toBeStubbornFetchErrorWith({
        type: StubbornFetchError.types.HTTP_ERROR,
        data: JSON.stringify({
          response: {
            status: 500,
            body: {status: 500, message: 'Uh oh!'},
          },
        }),
      });
    });

    it('resolves promise on success', () => {
      expect.assertions(1);

      return expect(
        new StubbornFetchRequest('callsResolve', fetchRequest, options).send(),
      ).resolves.toBeResponseWith({
        status: 200,
        body: JSON.stringify({hello: 'world'}),
      });
    });
  });

  describe('retry delay', () => {
    beforeAll(() => {
      _originalSetTimeoutFunv = window.setTimeout.bind({});
      _originalDateNowFunv = Date.now.bind({});
      window.setTimeout = jest.fn(setTimeout);

      // We override date so that no time passes throughout test; this makes things much easier to reason about.
      const d = Date.now();
      Date.now = jest.fn(() => d);
    });

    afterAll(() => {
      window.setTimeout = _originalSetTimeoutFunv;
      Date.now = _originalDateNowFunv;
    });

    beforeEach(() => {
      options.retries = 2;
      options.timingFunction = 'exponential';
    });

    afterEach(() => {
      window.setTimeout.mockClear();
    });

    it('delays based on given backoff ', async () => {
      expect.assertions(3);

      try {
        await new StubbornFetchRequest('--fail--backoffFunc', fetchRequest, options).send();
      } catch (e) {
        const {calls} = setTimeout.mock;
        expect(calls.find(c => c[1] === 1500)).toBeDefined();
        expect(fetchMock.calls('--fail--backoffFunc', 'get').length).toEqual(2);
        expect(e).toBeStubbornFetchErrorWith({
          type: 'HTTP',
          data: {
            response: {
              status: 500,
            },
          },
        });
      }
    });

    describe('429 handling', () => {
      beforeEach(() => {
        options.timingFunction = 'constant';
      });

      describe('when 429 "try again at" time doesn\'t go beyond total request time limit', () => {
        it('delays next retry for the length of the rate limit + 100ms, if longer than that given by backoff function', async () => {
          expect.assertions(3);

          try {
            await new StubbornFetchRequest('--fail429--rateLimit', fetchRequest, options).send();
          } catch (e) {
            const {calls} = setTimeout.mock;
            expect(calls.pop()[1]).toBe(2000 + 100);
            expect(fetchMock.calls('--fail429--rateLimit', 'get').length).toEqual(2);
            expect(e).toBeStubbornFetchErrorWith({
              type: 'HTTP',
              data: {
                response: {
                  status: 429,
                },
              },
            });
          }
        });
      });

      describe('when rate limit will not be up before total request time limit is elapsed', () => {
        it('rejects immediately', async () => {
          options.totalRequestTimeLimit = 2000;
          expect.assertions(2);

          try {
            await new StubbornFetchRequest(
              '--fail429LongTime--rateLimitImmediateFail',
              fetchRequest,
              options,
            ).send();
          } catch (e) {
            expect(
              fetchMock.calls('--fail429LongTime--rateLimitImmediateFail', 'get').length,
            ).toEqual(1);
            expect(e).toBeStubbornFetchErrorWith({
              type: StubbornFetchError.types.RATE_LIMITED,
            });
          }
        });
      });

      describe('when no retry-after header is returned', () => {
        it('follows normal backoff function', async () => {
          expect.assertions(3);

          try {
            await new StubbornFetchRequest(
              '--fail429NoRetryAfterHeader--',
              fetchRequest,
              options,
            ).send();
          } catch (e) {
            const {calls} = setTimeout.mock;
            expect(calls.pop()[1]).toBe(1000);
            expect(fetchMock.calls('--fail429NoRetryAfterHeader--', 'get').length).toEqual(2);
            expect(e).toBeStubbornFetchErrorWith({
              type: 'HTTP',
              data: {
                response: {
                  status: 429,
                },
              },
            });
          }
        });
      });
    });
  });

  describe('number of retries', () => {
    beforeAll(() => {
      _originalSetTimeoutFunv = window.setTimeout.bind({});
      window.setTimeout = jest.fn(setTimeout);
    });

    afterAll(() => {
      window.setTimeout = _originalSetTimeoutFunv;
    });

    beforeEach(() => {
      options.retries = 2;
      options.timingFunction = 'exponential';
    });

    it('retries up to the maximum retry option', async () => {
      expect.assertions(3);
      try {
        await new StubbornFetchRequest('--fail--maxRetry', fetchRequest, options).send();
      } catch (e) {
        const {calls} = setTimeout.mock;
        expect(calls.length).toEqual(options.retries);
        expect(fetchMock.calls('--fail--maxRetry', 'get').length).toBe(2);
        expect(e).toBeStubbornFetchErrorWith({
          type: 'HTTP',
          data: {
            response: {
              status: 500,
            },
          },
        });
      }
    });
  });

  describe('request timeout', () => {
    beforeEach(() => {
      options.retries = -1;
      options.totalRequestTimeLimit = 10;

      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('triggers timeout callback after defined totalRequestTimeLimit', () => {
      const promise = new StubbornFetchRequest('--fail--timesOut', fetchRequest, options)
        .send()
        .then(
          () => {},
          e => {
            rejection(e);
            expect(rejection).toBeCalledWith(
              expect.objectContaining({type: StubbornFetchError.types.TIMEOUT}),
            );
          },
        );

      // TODO: When we update jest, use runTimersToTime(11) here
      jest.runAllTimers();

      return promise;
    });
  });

  describe('retrying if status is above minimum', () => {
    beforeEach(() => {
      options.retries = 2;
      options.minimumStatusCodeForRetry = 400;
    });

    it('retries if status code greater than minimum', () => {
      expect.assertions(2);
      return new StubbornFetchRequest('--fail400--retryAboveMin', fetchRequest, options)
        .send()
        .then(
          () => {},
          e => {
            expect(fetchMock.calls('--fail400--retryAboveMin', 'get').length).toEqual(2);
            expect(e).toBeStubbornFetchErrorWith({
              type: 'HTTP',
              data: {
                response: {
                  status: 402,
                },
              },
            });
          },
        );
    });
  });

  describe('not retrying if status is below minimum', () => {
    beforeEach(() => {
      options.retries = 2;
      options.minimumStatusCodeForRetry = 505;
    });

    it('does not retry if status code less than minimum', () => {
      expect.assertions(2);
      return new StubbornFetchRequest('--fail400--retryBelowMin', fetchRequest, options)
        .send()
        .then(
          () => {},
          e => {
            expect(fetchMock.calls('--fail400--retryBelowMin', 'get').length).toEqual(1);
            expect(e).toBeStubbornFetchErrorWith({
              type: 'HTTP',
              data: {
                response: {
                  status: 402,
                },
              },
            });
          },
        );
    });

    it('does not retry if 401 is received regardless of minimumStatusCodeForRetry', () => {
      expect.assertions(2);

      options.minimumStatusCodeForRetry = 400;

      return new StubbornFetchRequest('--fail401--retryUnauth', fetchRequest, options).send().then(
        () => {},
        e => {
          expect(fetchMock.calls('--fail401--retryUnauth', 'get').length).toEqual(1);
          expect(e).toBeStubbornFetchErrorWith({
            type: 'HTTP',
            data: {
              response: {
                status: 401,
              },
            },
          });
        },
      );
    });
  });

  describe('global error limit', () => {
    beforeEach(() => {
      options.minimumStatusCodeForRetry = 400;
      options.retries = 3;
      options.maxErrors = 2;
    });

    it('does not retry more than maxErrors times', async () => {
      expect.assertions(3);
      try {
        await new StubbornFetchRequest('--fail--globalErrorLimit', fetchRequest, options).send();
      } catch (e) {
        expect(fetchMock.calls('--fail--globalErrorLimit', 'get').length).toBe(2);
        expect(StubbornFetchRequest.globalErrorCount).toBe(2);
        expect(e).toBeStubbornFetchErrorWith({
          type: StubbornFetchError.types.MAX_ERROS_EXCEEDED,
          data: {
            errorLimit: 2,
          },
        });
      }
    });

    it('will not initiate any new requests once global error limit has been reached', async () => {
      expect.assertions(3);

      StubbornFetchRequest.globalErrorCount = 2;

      try {
        await new StubbornFetchRequest(
          '--fail--globalErrorLimitAlreadyHit',
          fetchRequest,
          options,
        ).send();
      } catch (e) {
        expect(fetchMock.calls('--fail--globalErrorLimitAlreadyHit', 'get').length).toBe(0);
        expect(StubbornFetchRequest.globalErrorCount).toBe(2);
        expect(e).toBeStubbornFetchErrorWith({
          type: StubbornFetchError.types.MAX_ERROS_EXCEEDED,
          data: {
            errorLimit: 2,
          },
        });
      }
    });
  });

  describe('disabling (for burn it down)', () => {
    it('allows no further requests through when disabled', async () => {
      expect.assertions(2);

      StubbornFetchRequest.disable();

      try {
        await new StubbornFetchRequest('testDisabling', fetchRequest, options).send();
      } catch (e) {
        expect(fetchMock.calls('testDisabling', 'get').length).toBe(0);
        expect(e).toBeStubbornFetchErrorWith({
          type: StubbornFetchError.types.STUBBORN_FETCH_DISABLED,
        });
      }
    });

    it('allows no further retries through when disabled', async () => {
      expect.assertions(2);

      options.onError = () => StubbornFetchRequest.disable();
      options.retries = 2;

      try {
        await new StubbornFetchRequest(
          '--fail--noRetriesAfterDisable',
          fetchRequest,
          options,
        ).send();
      } catch (e) {
        expect(fetchMock.calls('--fail--noRetriesAfterDisable', 'get').length).toBe(1);
        expect(e).toBeStubbornFetchErrorWith({
          type: StubbornFetchError.types.STUBBORN_FETCH_DISABLED,
        });
      }
    });
  });

  describe('error hooks', () => {
    beforeEach(() => {
      options.retries = 2;
      options.onError = jest.fn();
    });

    it('calls error handler once per retry', () => {
      return new StubbornFetchRequest('--fail--errorHook', fetchRequest, options).send().then(
        () => {},
        () => {
          expect(options.onError.mock.calls.length).toEqual(2);
        },
      );
    });
  });
});
