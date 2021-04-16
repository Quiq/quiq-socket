import StatusCodes from './StatusCodes';
import clamp from 'lodash/clamp';
import {formatQueryParams} from './Utils';

// Support for webworker context's 'self' and IE11 compatibility (no globalThis)
const global =
  typeof self !== 'undefined'
    ? self
    : typeof window !== 'undefined'
    ? window
    : typeof globalThis !== 'undefined'
    ? globalThis
    : undefined;

type Timeout = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

type Timers = {
  connectionTimeout: Timeout | null | undefined; // Timeout for connection/handshake attempt
  retryTimeout: Timeout | null | undefined; // Timeout for backoff on retry attempts
  heartbeat: {
    interval: Interval | null | undefined; // Interval for sending of heartbeat
    timeout: Timeout | null | undefined; // Timeout for receiving a pong back from the server
  };
  gracePeriod: Timeout | null | undefined;
};

type SocketHealthChangeEvent = {
  connectionCount: number;
  lastPingSentTimestamp: number | undefined;
  lastPongReceivedTimestamp: number | undefined;
  connectionOpenedTimestamp: number | undefined;
  heartbeatJitter: number | undefined;
  heartbeatRtts: Array<number>;
  socketErrors: Array<any>;
};

interface Logging {
  info: (...args: Array<any>) => void;
  warn: (...args: Array<any>) => void;
  error: (...args: Array<any>) => void;
}

export type FatalErrorReason = 'MAX_CONNECTION_COUNT_EXCEEDED' | 'UNKNOWN';

export type EventName = 'connectionLoss' | 'connectionEstablish' | 'message' | 'fatalError';

export interface FatalErrorCallbackData {
  reason: FatalErrorReason;
}

export type Options = {
  // Number of times to attempt reconnecting on a single connection
  maxRetriesOnConnectionLoss: number;

  // Function of the form attempt => delay used for delaying retry attempts
  backoffFunction: (attempt: number) => number;

  // the maximum number of times connect() will be called, either externally or in doing retries, for the entire session.
  maxConnectionCount: number;

  // The timeout for WebSocket.onopen to be called for a connection attempt.
  connectionAttemptTimeout: number;

  // Frequency to send ping across websocket
  heartbeatFrequency: number;

  // Initiate reconnect if pong is not received in this time
  heartbeatTimeout: number;

  // Upon unexpected disconnect, try to reconnect for this long before admitting there's an error.
  gracePeriod: number;

  // When retrying attempts, a randomized entropy in MS is added to avoid multiple connections simultaneously retrying
  maxEntropy: number;

  // Defines a hook function, called before every connection attempt
  // that can provide the protocol string to be used for the WebSocket connection.
  // This can be used to pass an auth token securely to your backend.
  protocolHook?: () => string | null | undefined;

  // Defines a hook function, called before every connection attempt
  // that can provide the query arguments to be appended to the WebSocket URL
  queryArgHook?: () =>
    | {
        [key: string]: string;
      }
    | null
    | undefined;

  // Defines a hook function, called before every connection attempt,
  // that can block the connection attempt by returning false.
  connectionGuardHook?: () => boolean;

  // Defines a callback function, called whenever socket health statistics change
  onSocketHealthChange?: (e: SocketHealthChangeEvent) => void;
};

export enum FatalErrors {
  MAX_CONNECTION_COUNT_EXCEEDED = 'MAX_CONNECTION_COUNT_EXCEEDED',
  UNKNOWN = 'UNKNOWN',
}

export enum Events {
  CONNECTION_LOSS = 'connectionLoss',
  CONNECTION_ESTABLISH = 'connectionEstablish',
  MESSAGE = 'message',
  FATAL_ERROR = 'fatalError',
}

class QuiqSocket {
  // Socket endpoint
  _url: string | null | undefined;

  // External event callbacks
  _handlers: Record<EventName, any[]> = {
    [Events.CONNECTION_ESTABLISH]: [],
    [Events.CONNECTION_LOSS]: [],
    [Events.MESSAGE]: [],
    [Events.FATAL_ERROR]: [],
  };

  // Websocket options
  _options: Options = {
    maxRetriesOnConnectionLoss: 100,
    backoffFunction: (attempt: number) => {
      const exponentialBackoff = clamp((attempt ** 2 / 2) * 1000, 0, 30000);
      const absoluteEntropy = Math.round(Math.random() * this._options.maxEntropy);
      return exponentialBackoff + absoluteEntropy;
    },
    maxConnectionCount: 100,
    connectionAttemptTimeout: 10 * 1000,
    heartbeatFrequency: 50 * 1000,
    heartbeatTimeout: 20 * 1000,
    gracePeriod: 20 * 1000,
    maxEntropy: 10 * 1000,
  };

  // Internal WebSocket instance
  _socket: WebSocket | null | undefined;

  // Retry and connection counting
  _retries = 0;
  _connectionCount = 0;

  // Timers and intervals
  _timers: Timers = {
    connectionTimeout: null,
    retryTimeout: null,
    heartbeat: {
      interval: null,
      timeout: null,
    },
    gracePeriod: null,
  };

  // Connection state
  _lastPingSentTimestamp: number | undefined;
  _lastPongReceivedTimestamp: number | undefined;
  _connectionOpenedTimestamp: number | undefined;
  _heartbeatRtts: Array<number> = [];
  _heartbeatJitter: number | undefined;
  _socketErrors: Array<any> = [];

  // Status flags
  _waitingForOnlineToReconnect = false;
  _inRetryCycle = false;
  _connecting = false;

  // Logger
  _log: Logging = console;

  constructor() {
    if (global !== undefined) {
      // NOTE: We use 'waitingForOnlineToReconnect' as a flag for whether to attempt reconnecting after an 'online' event.
      // In other words, QuiqSocket must have recorded an 'offline' event prior to the 'online' event if it's going to reconnect.
      global.addEventListener('online', () => {
        this._log.info('QuiqSocket online event');
        if (this._waitingForOnlineToReconnect) {
          this.connect();
        }
        this._waitingForOnlineToReconnect = false;
      });

      global.addEventListener('offline', () => {
        this._log.info('QuiqSocket offline event');
        if (this._socket) {
          this._waitingForOnlineToReconnect = true;
          this._reset();
          this._fireHandlers(Events.CONNECTION_LOSS, {code: 0, reason: 'Browser offline'});
        }
      });

      // Unload listener - the browser implementation should send close frame automatically, but you can never be too sure...
      global.addEventListener('unload', () => {
        this._log.info('QuiqSocket unload event');
        if (this._socket) {
          this._reset();
        }
        return null;
      });

      // Focus listener: this is used to detect computer coming back from sleep, but will be fired anytime tab is focused.
      if (global.document) {
        global.document.addEventListener('visibilitychange', () => {
          if (!document.hidden) {
            void this.verifyConnectivity().catch(reason => this._log.error(reason));
          }
        });
      }
    } else {
      // If we can't detect the global context, connecting the socket will throw anyway, so just error here instead
      throw new Error('QuiqSockets: Global context is not compatible');
    }
  }

  /** ******************************
   * Public Methods
   ****************************** */

  /**
   * Adds an event listener to the specified event.
   * This method is idempotent.
   */
  addEventListener = (event: EventName, handler: (data: any) => void): QuiqSocket => {
    if (!this._handlers[event].includes(handler)) {
      this._handlers[event].push(handler);
    }
    return this;
  };

  /**
   * Removes a given event handler.
   */
  removeEventListener = (event: EventName, handler: (data: any) => void): QuiqSocket => {
    const idx = this._handlers[event].indexOf(handler);
    if (idx > -1) {
      this._handlers[event].splice(idx, 1);
    }
    return this;
  };

  /**
   * Sets the socket endpoint to connect to. Must be called prior to calling connect()
   * @param {string} url - A websocket endpoint. Must begin with `ws://` or `wss://`
   * @returns {QuiqSocket} This instance of QuiqSocket, to allow for chaining
   */
  withURL = (url: string): QuiqSocket => {
    this._url = url;
    return this;
  };

  withLogger = (logger: Logging): QuiqSocket => {
    this._log = logger;
    return this;
  };

  /**
   * Updates default options with the object provided. (IThese options are merged with the defaults.)
   * @param {Partial<Options>} options - An object containing QuiqSocket options.
   * @returns {QuiqSocket} This instance of QuiqSocket, to allow for chaining
   */
  withOptions = (options: Partial<Options>): QuiqSocket => {
    // Option validation
    const heartbeatTimeout = options.heartbeatTimeout || this._options.heartbeatTimeout;
    const heartbeatFrequency = options.heartbeatFrequency || this._options.heartbeatFrequency;
    const maxConnectionCount = options.maxConnectionCount || this._options.maxConnectionCount;

    if (heartbeatFrequency < 1000) {
      this._log.error(
        `Invalid QuiqSocket Options: Heartbeat frequency cannot be set to less than 1000 ms. Not updating options`,
      );
      return this;
    }

    if (heartbeatTimeout < 1000) {
      this._log.error(
        `Invalid QuiqSocket Options: Heartbeat timeout cannot be set to less than 1000 ms. Not updating options`,
      );
      return this;
    }

    if (heartbeatTimeout >= heartbeatFrequency) {
      this._log.error(
        'Invalid QuiqSocket Options: Heartbeat timeout must be less than heartbeat interval. Not updating options',
      );
      return this;
    }

    if (maxConnectionCount < 1) {
      this._log.error(
        'Invalid QuiqSocket Options: Max connection count must be greater than 0. Not updating options',
      );
      return this;
    }

    this._options = {...this._options, ...options};

    this._log.info(`Socket heartbeat frequency set to ${this._options.heartbeatFrequency}`);
    this._log.info(`Socket heartbeat timeout set to ${this._options.heartbeatTimeout}`);
    this._log.info(`Max connection count set to ${this._options.maxConnectionCount}`);
    return this;
  };

  /**
   * Connect the websocket. `withURL()` must be called prior to calling this method.
   * If a WS connection is currently open, it is closed and a new one is created.
   * @returns {QuiqSocket} This instance of QuiqSocket, to allow for chaining
   */
  connect = (): QuiqSocket => {
    // Make this thing idempotent: if a connection is already in progress, let it be
    if (this._connecting) {
      return this;
    }

    this._connecting = true;

    // Check burn status
    if (this._options.connectionGuardHook && !this._options.connectionGuardHook()) {
      this._log.error('Connection guard hook returned falsy, aborting connection attempt.');
      return this;
    }

    if (!(global && global.WebSocket)) {
      throw new Error('QuiqSockets: This browser does not support websockets');
    }

    if (this._connectionCount >= this._options.maxConnectionCount) {
      this._log.error('Maximum connection count exceeded. Aborting.');
      this._handleFatalError(FatalErrors.MAX_CONNECTION_COUNT_EXCEEDED);
      return this;
    }

    // Reset connection and timeout state
    this._reset();

    this._log.info('Connecting socket...');

    // Check that we have a URL
    if (!this._url) {
      this._log.error('A URL must be provided before connecting. Aborting connection.');
      return this;
    }

    // Grab protocol and query args via hooks
    let protocol, queryArgs;
    if (this._options.protocolHook) {
      const hookResult = this._options.protocolHook();
      if (typeof hookResult === 'string') {
        protocol = hookResult;
      } else {
        this._log.warn('The protocol hook did not return a string value, discarding.');
      }
    }

    if (this._options.queryArgHook) {
      queryArgs = this._options.queryArgHook();
    }

    // Connect socket.
    const parsedUrl = formatQueryParams(this._url, queryArgs);

    // Set timeout to trigger reconnect if _onOpen isn't called quiqly enough
    // This catches all cases where we fail to even open the socket--even if construction fails in the try/catch below.
    this._timers.connectionTimeout = setTimeout(() => {
      this._log.warn('Connection attempt timed out.');
      this._connecting = false;
      this._fireHandlers(Events.CONNECTION_LOSS, {code: 0, reason: 'Connection timeout'});
      this._retryConnection();
    }, this._options.connectionAttemptTimeout);

    // Make connection
    try {
      this._socket = protocol ? new WebSocket(parsedUrl, protocol) : new WebSocket(parsedUrl);
    } catch (e) {
      this._log.error(`Unable to construct WebSocket: ${e.message}`, {
        data: {url: parsedUrl},
        exception: e,
      });
      throw new Error('QuiqSocket: Cannot construct WebSocket.');
    }

    // Register internal event handlers with WebSocket instance.
    this._socket.onopen = this._handleOpen;
    this._socket.onclose = this._handleClose;
    this._socket.onerror = this._handleSocketError;
    this._socket.onmessage = this._handleMessage;

    // Increment "global" connection count
    this._connectionCount++;
    this._onSocketHealthChange();

    return this;
  };

  /**
   * Disconnect the websocket. If no connection is active has no effect, but does not error out.
   * @returns {QuiqSocket} This instance of QuiqSocket, to allow for chaining
   */
  disconnect = (): QuiqSocket => {
    if (this._socket) {
      this._log.info('Closing socket intentionally');
    }

    this._reset();

    this._connecting = this._inRetryCycle = false;

    return this;
  };

  /**
   * Verifies websocket connectivity.  Checks the time since the last received heartbeat response
   * to make sure it's within the heartbeat frequency.  If it isn't, initiates reconnection.  If it is,
   * ensures communications are open by firing a manual heartbeat and waiting for the response.  If no response
   * is received within the heartbeatTimeout, initiates reconnection; if one is, restarts heartbeat.
   * @returns A boolean promise. Resolves to true if socket appears healthy and communcation is confirmed or
   *          false if socket isn't ready or has missed a heartbeat. Rejects if the socket appears healthy but
   *          manual communication attempt times out.
   */
  verifyConnectivity = (): Promise<boolean> => {
    return new Promise((res, rej) => {
      // Only continue if we are in CONNECTED state (readyState === 1)
      if (!this._socket || this._socket.readyState !== 1 || !this._lastPongReceivedTimestamp) {
        this._log.warn('Connectivity could not be verified - socket not in a ready state', {
          socketDefined: !!this._socket,
          readyState: this._socket && this._socket.readyState,
          lastPongTimestamp: this._lastPongReceivedTimestamp,
        });
        return res(false);
      }

      this._log.info('Verifying connectivity');

      if (Date.now() - this._lastPongReceivedTimestamp > this._options.heartbeatFrequency) {
        // Fire connection loss handlers and initiate reconnect
        this._log.info('Our heart has skipped a beat...reconnecting.');
        this._fireHandlers(Events.CONNECTION_LOSS, {code: 0, reason: 'Heartbeat failure'});
        this.connect();
        res(false);
      } else {
        // Ensure socket communication is open with manual heartbeat
        this._log.info('Socket appears healthy, sending manual heartbeat PING');

        this._socket.onmessage = (e: MessageEvent) => {
          if (e.data && e.data === 'X') {
            // Put the normal handler back and update state
            if (this._socket) this._socket.onmessage = this._handleMessage;
            this._pongReceived();

            // Clear and restart normal heartbeat
            if (this._timers.heartbeat.timeout) {
              clearTimeout(this._timers.heartbeat.timeout);
              this._timers.heartbeat.timeout = null;
            }
            this._startHeartbeat(true);

            return res(true);
          }
          // Invoke normal handler if other data comes through!
          this._handleMessage(e);
        };

        // Set manual heartbeatTimeout
        if (this._timers.heartbeat.timeout) clearTimeout(this._timers.heartbeat.timeout);
        this._timers.heartbeat.timeout = setTimeout(() => {
          // If manual heartbeat times out, the connection may not be functional, let's rebuild it to be safe
          this._fireHandlers(Events.CONNECTION_LOSS, {code: 0, reason: 'Heartbeat timeout'});
          this.connect();
          rej('Socket appeared healthy but communication is unresponsive');
        }, this._options.heartbeatTimeout);

        this._sendPing();
      }
    });
  };

  /** ******************************
   * Private Members
   ****************************** */

  /**
   * Initiates reconnection attempt. Delays attempt based on `options.backoffFunction`.
   * @private
   */
  _retryConnection = () => {
    if (this._retries >= this._options.maxRetriesOnConnectionLoss) {
      this._log.error('Maximum socket connection retries exceeded. Aborting connection.');
      this._handleFatalError(FatalErrors.MAX_CONNECTION_COUNT_EXCEEDED);
      return;
    }

    this._log.info(
      `Initiating retry attempt ${this._retries + 1} of ${
        this._options.maxRetriesOnConnectionLoss
      }`,
    );

    this._inRetryCycle = true;

    const delay = this._options.backoffFunction.call(this, this._retries);

    // Reset state
    this._reset();

    this._log.info(`Delaying socket reconnect attempt for ${delay} ms`);

    setTimeout(this.connect, delay);

    this._retries++;
  };

  /**
   * Resets all connection-specific state including the WebSocket instance itself and all timers.
   * Removes all event handlers for WebSocket. Does **not** reset retry count. (This is done in the onOpen handler.)
   * This method is idempotent...use it liberally to ensure multiple socket connections are not created.
   * @private
   */
  _reset = () => {
    this._log.info('Resetting socket state');
    // Close existing connection
    if (this._socket) {
      // Remove event handlers -- we don't care about this socket anymore.
      this._socket.onopen = () => {};
      this._socket.onclose = () => {};
      this._socket.onerror = () => {};
      this._socket.onmessage = () => {};

      // NOTE: Tests have shown that the below is an effective way to close the socket even when called while the readyState is CONNECTING
      this._socket.close(StatusCodes.closeNormal, 'Closing socket');
      this._socket = null;

      this._log.info('Closed existing connection and removed event handlers.');
    }

    if (this._timers.retryTimeout) {
      clearTimeout(this._timers.retryTimeout);
      this._timers.retryTimeout = null;
      this._log.info('Invalidated retry delay timeout');
    }

    if (this._timers.connectionTimeout) {
      clearTimeout(this._timers.connectionTimeout);
      this._timers.connectionTimeout = null;
      this._log.info('Invalidated connection open timeout');
    }

    if (this._timers.heartbeat.interval) {
      clearInterval(this._timers.heartbeat.interval);
      this._timers.heartbeat.interval = null;
      this._log.info('Invalidated heartbeat interval');
    }

    if (this._timers.heartbeat.timeout) {
      clearTimeout(this._timers.heartbeat.timeout);
      this._timers.heartbeat.timeout = null;
      this._log.info('Invalidated heartbeat timeout');
    }

    this._lastPingSentTimestamp = undefined;
    this._lastPongReceivedTimestamp = undefined;
    this._heartbeatRtts.length = 0;
    this._heartbeatJitter = undefined;
  };

  /**
   * Internal handler for handling a new WebSocket message. Parses data payload and fires callback.
   * @param {MessageEvent} e
   * @private
   */
  _handleMessage = (e: MessageEvent) => {
    // If this is a pong, update pong timestamp and clear heartbeat timeout
    if (e.data && e.data === 'X') {
      this._pongReceived();

      if (this._timers.heartbeat.timeout) {
        clearTimeout(this._timers.heartbeat.timeout);
        this._timers.heartbeat.timeout = null;
      }
      return;
    }

    try {
      // Make sure data is a string
      if (typeof e.data === 'string') {
        const parsedData = JSON.parse(e.data);
        // Fire event handlers
        this._fireHandlers(Events.MESSAGE, parsedData);
      } else {
        this._log.error('Websocket message data was not of string type');
      }
    } catch (ex) {
      this._log.error(`Unable to handle websocket message: ${ex.message}`, {
        data: {message: e.data},
        exception: ex,
      });
    }
  };

  /**
   * Internal handler for socket open. Clears connection timeout and retry count. Fires external callback.
   * @private
   */
  _handleOpen = () => {
    if (!this._socket || !this._socket.url) {
      this._log.error('Open handler called, but socket or socket URL was undefined');
      return;
    }

    this._log.info(`Socket opened to ${this._socket.url}`);
    this._connectionOpenedTimestamp = Date.now();
    this._onSocketHealthChange();

    // Clear timeout
    if (this._timers.connectionTimeout) {
      clearTimeout(this._timers.connectionTimeout);
      this._timers.connectionTimeout = null;
    }

    // Clear grace period
    if (this._timers.gracePeriod) {
      clearTimeout(this._timers.gracePeriod);
      this._timers.gracePeriod = null;
    }

    // Reset retry count
    this._retries = 0;

    // We're obviously not trying to reconnect anymore
    this._connecting = this._inRetryCycle = false;

    // Begin heartbeats
    this._startHeartbeat();

    // Fire event handler
    this._fireHandlers(Events.CONNECTION_ESTABLISH);
  };

  /**
   * Internal handler for WebSocket unexpected close. Calls reset(), then initiates new connection.
   * @param {CloseEvent} e
   * @private
   */
  _handleClose = (e: CloseEvent) => {
    const dirtyOrClean = e.wasClean ? 'CLEANLY' : 'DIRTILY';
    this._log.info(`Socket ${dirtyOrClean} closed unexpectedly with code ${e.code}: ${e.reason}.`);

    this._connecting = false; // In case it closed during connection attempt

    // TODO: handle code 1015 (TCP 1.1 not supported)
    // TODO: Investigate other status codes to handle specifically

    // Fire callback after grace period, but only if this is the close event that STARTS a reconnect cycle.
    // (We only want one grace period per disconnect/retry cycle)
    if (!this._inRetryCycle) {
      this._timers.gracePeriod = setTimeout(() => {
        this._timers.gracePeriod = null;
        this._log.info('Grace period expired');
        this._fireHandlers(Events.CONNECTION_LOSS, {code: e.code, reason: e.reason});
      }, this._options.gracePeriod);

      // Initiate retry procedure
      this._retryConnection();
    }
  };

  /**
   * WebSocket error handler. Logs warning, but does nothing else. (Close handler will deal with error resolution.)
   * @private
   */
  _handleSocketError = (e: any) => {
    // NOTE: onError event is not provided with any information, onClose must deal with causeality.
    // This is simply a notification.
    // We'll pass a potential exception just in case; apparently some browsers will provide one.
    this._log.warn('A websocket error occurred.', {exception: e});
    try {
      const safeError = JSON.parse(JSON.stringify(e));
      this._socketErrors.push(safeError);
    } catch (e) {
      this._socketErrors.push('Unknown error');
    }
    this._onSocketHealthChange();
  };

  /**
   * Handles a fatal, non-recoverable error such as hitting the retry maximum.
   * @private
   */
  _handleFatalError = (reason: FatalErrorReason) => {
    this._log.error('QuiqSocket encountered a fatal error.');

    this._fireHandlers(Events.FATAL_ERROR, {reason});
  };

  /**
   * Initiates websocket heartbeat interval. Must be called upon websocket open. Heartbeat interval must be cleared upon socket close.
   * @private
   */
  _startHeartbeat = (restarting = false) => {
    if (this._timers.heartbeat.interval) {
      clearInterval(this._timers.heartbeat.interval);
    }

    const heartBeat = () => {
      // Initiate heartbeat timeout--we must receive a pong back within this time frame.
      // This will be cleared when we receive an 'X'
      if (this._timers.heartbeat.timeout) {
        clearTimeout(this._timers.heartbeat.timeout);
      }
      this._timers.heartbeat.timeout = setTimeout(() => {
        this._log.warn('Heartbeat pong not received back in time. Reconnecting.');
        this._fireHandlers(Events.CONNECTION_LOSS, {code: 0, reason: 'Heartbeat timeout'});
        this._reset();
        this.connect();
      }, this._options.heartbeatTimeout);

      this._sendPing();
    };

    this._timers.heartbeat.interval = setInterval(heartBeat, this._options.heartbeatFrequency);

    // Execute initial beat if needed
    if (!restarting) heartBeat();
  };

  /**
   * Sends a websocket heartbeat message ('X')
   * @private
   */
  _sendPing = () => {
    // Verify we have a socket connection
    if (!this._socket) {
      this._log.error('Trying to send heartbeat, but no socket connection exists.');
      return;
    }

    // Send ping
    this._lastPingSentTimestamp = Date.now();
    this._socket.send('X');
  };

  /**
   * Updates socket round-trip-time measurements
   * @private
   */
  _pongReceived = () => {
    this._lastPongReceivedTimestamp = Date.now();

    if (
      this._lastPingSentTimestamp === undefined ||
      this._lastPongReceivedTimestamp === undefined
    ) {
      return;
    }

    // RTT
    const rtt = this._lastPongReceivedTimestamp - this._lastPingSentTimestamp;
    this._heartbeatRtts.push(rtt);
    // We only care about the most recent values
    if (this._heartbeatRtts.length > 10) {
      this._heartbeatRtts.shift();
    }
    this._log.info(`Last heartbeat RTT: ${rtt} ms`);

    // Jitter
    if (this._heartbeatRtts.length > 1) {
      const meanRtt = Math.round(
        this._heartbeatRtts.reduce((acc, val) => acc + val) / this._heartbeatRtts.length,
      );
      this._log.info(`Mean RTT: ${meanRtt} ms`);

      const diffs = this._heartbeatRtts.map((rtt, i) => {
        if (i === 0) return 0; // first value isn't useful
        return Math.abs(rtt - this._heartbeatRtts[i - 1]);
      });
      diffs.shift(); // discard useless value

      this._heartbeatJitter = Math.round(diffs.reduce((acc, val) => acc + val) / diffs.length);
      this._log.info(
        `Hearbeat Jitter: ${this._heartbeatJitter} ms (${Math.round(
          (this._heartbeatJitter / meanRtt) * 100,
        )}%)`,
      );
    }

    this._onSocketHealthChange();
  };

  /**
   * Invokes the onSocketHealthChange callback, if provided
   * @private
   */
  _onSocketHealthChange = () => {
    if (typeof this._options.onSocketHealthChange === 'function') {
      this._options.onSocketHealthChange({
        connectionCount: this._connectionCount,
        lastPingSentTimestamp: this._lastPingSentTimestamp,
        lastPongReceivedTimestamp: this._lastPongReceivedTimestamp,
        connectionOpenedTimestamp: this._connectionOpenedTimestamp,
        heartbeatJitter: this._heartbeatJitter,
        heartbeatRtts: this._heartbeatRtts,
        socketErrors: this._socketErrors,
      });
    }
  };

  _fireHandlers = (event: EventName, data?: Record<string, unknown>) => {
    this._handlers[event].forEach(handler => {
      if (data) {
        handler(data);
      } else {
        handler();
      }
    });
  };
}

export default QuiqSocket;
