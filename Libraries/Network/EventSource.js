/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow
 */

'use strict';

const EventTarget = require('event-target-shim');
const RCTNetworking = require('./RCTNetworking');

const EVENT_SOURCE_EVENTS = [
  'error',
  'message',
  'open',
  'debug',
];

// char codes
const bom = [239, 187, 191]; // byte order mark
const lf = 10;
const cr = 13;

/**
 * An RCTNetworking-based implementation of the EventSource web standard.
 * 
 * See https://developer.mozilla.org/en-US/docs/Web/API/EventSource
 *     https://html.spec.whatwg.org/multipage/server-sent-events.html
 *     https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
 */
class EventSource extends EventTarget(...EVENT_SOURCE_EVENTS) {
  static CONNECTING: number = 0;
  static OPEN: number = 1;
  static CLOSED: number = 2;

  // Properties
  readyState: number = EventSource.CONNECTING;
  url: string;
  withCredentials: boolean = false;

  // Event handlers
  onerror: ?Function;
  onmessage: ?Function;
  onopen: ?Function;
  ondebug: ?Function;
  
  // Buffers for event stream parsing
  _isFirstChunk = false;
  _discardNextLineFeed = false;
  _lineBuf: string = "";
  _dataBuf: string = "";
  _eventTypeBuf: string = "";
  _lastEventIdBuf: string = "";
  
  _lastEventId: string = "";
  _reconnectIntervalMs: number = 1000;
  _requestId: ?number;
  _subscriptions: Array<*>;
  _trackingName: string = 'unknown';

  /**
   * Custom extension for tracking origins of request.
   */
  setTrackingName(trackingName: string): EventSource {
    this._trackingName = trackingName;
    return this;
  }

  /**
   * Creates a new EventSource
   * @param {string} url the URL at which to open a stream
   * @param {?Object} eventSourceInitDict extra configuration parameters
   */
  constructor(url: string, eventSourceInitDict: ?Object) {
    super();

    if (!url) {
      throw new Error('Cannot open an SSE stream on an empty url');
    }
    this.url = url;

    let headers: Object = { 'Cache-Control': 'no-store', 'Accept': 'text/event-stream' };
    if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;

    if (eventSourceInitDict) {
      if (eventSourceInitDict.headers) {
        if (eventSourceInitDict.headers['Last-Event-ID']) {
          this._lastEventId = eventSourceInitDict.headers['Last-Event-ID'];
          delete eventSourceInitDict.headers['Last-Event-ID'];
        }

        for (var headerKey in eventSourceInitDict.headers) {
          const header = eventSourceInitDict.headers[headerKey]
          if (header) {
            headers[headerKey] = header;
          }
        }
      } 

      if (eventSourceInitDict.withCredentials) {
        this.withCredentials = eventSourceInitDict.withCredentials;
      }
    }

    this._subscriptions = [];
    this._subscriptions.push(
      RCTNetworking.addListener('didReceiveNetworkResponse', args =>
        this.__didReceiveResponse(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didReceiveNetworkIncrementalData', args =>
        this.__didReceiveIncrementalData(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didCompleteNetworkResponse', args =>
        this.__didCompleteResponse(...args),
      ),
    );

    RCTNetworking.sendRequest(
      "GET", // EventSource always GETs the resource
      this._trackingName,
      this.url,
      headers,
      "", // body for EventSource request is always empty
      "text", // SSE is a text protocol
      true, // we want incremental events
      0, // there is no timeout defined in the WHATWG spec for EventSource
      this.__didCreateRequest.bind(this),
      this.withCredentials,
    );
  }

  close(): void {
    this.dispatchEvent({type: 'debug', message: 'closing the event source'})
    if (this._requestId !== null && this._requestId !== undefined) {
      RCTNetworking.abortRequest(this._requestId);
    }

    // clean up RCTNetworking subscriptions
    (this._subscriptions || []).forEach(sub => {
      if (sub) {
        sub.remove();
      }
    });
    this._subscriptions = [];

    this.readyState = EventSource.CLOSED;
  }

  // Internal buffer processing methods

  __processEventStreamChunk(chunk: string): void {
    if (this._isFirstChunk) {
      if (bom.every((charCode, idx) => { return this._lineBuf.charCodeAt(idx) === charCode; })) {
        // Strip byte order mark from chunk
        chunk = chunk.slice(bom.length);
      };
      this._isFirstChunk = false;
    }

    let pos: number = 0;
    while (pos < chunk.length) {
      if (this._discardNextLineFeed) {
        if (chunk.charCodeAt(pos) === lf) {
          // Ignore this LF since it was preceded by a CR
          ++pos;
        }
        this._discardNextLineFeed = false;
      }

      const curCharCode = chunk.charCodeAt(pos);
      if (curCharCode === cr || curCharCode === lf) {
        this.__processEventStreamLine();

        // Treat CRLF properly
        if (curCharCode === cr) {
          this._discardNextLineFeed = true;
        }
      } else {
          this._lineBuf += chunk.charAt(pos);
      }

      ++pos;
    }
  }

  __processEventStreamLine(): void {
    const line = this._lineBuf;

    // clear the line buffer
    this._lineBuf = "";

    this.dispatchEvent({type: 'debug', message: `processing line: "${line}"`})

    // Dispatch the buffered event if this is an empty line
    if (line === '') {
      this.__dispatchBufferedEvent();
      return;
    }

    const colonPos = line.indexOf(':');

    let field: string;
    let value: string;

    if (colonPos === 0) {
      // this is a comment line and should be ignored
      return;
    } else if (colonPos > 0) {
      if (line[colonPos + 1] == " ") {
        field = line.slice(0, colonPos);
        value = line.slice(colonPos + 2); // ignores the first space from the value
      } else {
        field = line.slice(0, colonPos);
        value = line.slice(colonPos + 1);
      }
    } else {
      field = line
      value = "";
    }

    switch (field) {
      case "event":
        // Set the type of this event
        this._eventTypeBuf = value;
        break;
      case "data":
        // Append the line to the data buffer along with an LF (U+000A)
        this._dataBuf += value;
        this._dataBuf += String.fromCodePoint(lf);
        break;
      case "id":
        // Update the last seen event id
        this._lastEventIdBuf = field;
        break;
      case "retry":
        // Set a new reconnect interval value
        const newRetryMs = parseInt(value, 10);
        if (newRetryMs != NaN) {
          this._reconnectIntervalMs = newRetryMs;
        }
        break;
      default:
        // this is an unrecognized field, so this line should be ignored
    }
  }

  __dispatchBufferedEvent() {
    this._lastEventId = this._lastEventIdBuf;

    // If the data buffer is an empty string, set the event type buffer to
    // empty string and return
    if (this._dataBuf === "") {
      this._eventTypeBuf = "";
      return;
    }

    // Dispatch the event
    const eventType = this._eventTypeBuf || 'message';
    this.dispatchEvent({
      type: eventType,
      data: this._dataBuf.slice(0, -1), // remove the trailing LF from the data
      origin: this.url,
      lastEventId: this._lastEventId,
    });

    // Reset the data and event type buffers
    this._dataBuf = "";
    this._eventTypeBuf = "";
  }

  // RCTNetworking callbacks

  __didCreateRequest(requestId: number): void {
    this._requestId = requestId;
  }

  __didReceiveResponse(
    requestId: number,
    status: number,
    responseHeaders: ?Object,
    responseURL: ?string,
  ): void {
    this.dispatchEvent({ type: 'debug', message: `request ${requestId} didReceiveResponse: ${status}`});
    if (requestId === this._requestId) {
      // Handle HTTP 5XX errors
      if (status === 500 || status === 502 || status === 503 || status === 504) {
        // TODO: abort connection
        this.dispatchEvent({type: 'error', message: "HTTP error" + status});
        return;
      }

      // Handle redirects
      if (status === 301 || status === 307) {
        // TODO: handle redirect
        this.dispatchEvent({type: 'error', message: "redirect not supported"});
        return
      }

      if (status !== 200) {
        this.dispatchEvent({type: 'error', message: "HTTP error " + status});
        return this.close();
      }

      // make the header names case insensitive
      for (const entry of Object.entries(responseHeaders)) {
          const [key, value] = entry;
          delete responseHeaders[key];
          responseHeaders[key.toLowerCase()] = value;
      }

      if (responseHeaders && responseHeaders["content-type"] !== "text/event-stream") {
        this.dispatchEvent({type: 'error', message: "unsupported MIME type in response" + JSON.stringify(responseHeaders)});
        return this.close();  
      }

      this.readyState = this.OPEN;
      this.dispatchEvent({type: 'open'});
    }
  }

  __didReceiveIncrementalData(
    requestId: number,
    responseText: string,
    progress: number,
    total: number,
  ) {
    this.dispatchEvent({type: 'debug', message: `request ${requestId} didReceiveIncrementalData: ${responseText}, progress ${progress}, total ${total}`});
    if (requestId !== this._requestId) {
      return;
    }

    this.__processEventStreamChunk(responseText);
  }

  __didCompleteResponse(
    requestId: number,
    error: string,
    timeOutError: boolean,
  ): void {
    this.dispatchEvent({type: 'debug', message: `request ${requestId} didCompleteResponse: ${error}, timeoutError ${timeOutError}`});
    if (requestId === this._requestId) {
      // TODO: handle error where request never makes it out the door
    }
  }
}

module.exports = EventSource;
