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
];

// char codes
const bom = [239, 187, 191]; // byte order mark
const space = 32;
const lf = 10;
const cr = 13;

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

    this._subscriptions.push(
      RCTNetworking.addListener('didSendNetworkData', args =>
        this.__didUploadProgress(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didReceiveNetworkResponse', args =>
        this.__didReceiveResponse(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didReceiveNetworkData', args =>
        this.__didReceiveData(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didReceiveNetworkIncrementalData', args =>
        this.__didReceiveIncrementalData(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didReceiveNetworkDataProgress', args =>
        this.__didReceiveDataProgress(...args),
      ),
    );
    this._subscriptions.push(
      RCTNetworking.addListener('didCompleteNetworkResponse', args =>
        this.__didCompleteResponse(...args),
      ),
    );

    RCTNetworking.sendRequest(
      "GET",
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
    if (this._requestId !== null && this._requestId !== undefined) {
      RCTNetworking.abortRequest(this._requestId);
    }
    // Clear RCTNetworking subscriptions
    (this._subscriptions || []).forEach(sub => {
      if (sub) {
        sub.remove();
      }
    });
    this._subscriptions = [];

    this.readyState = EventSource.CLOSED;
  }

  
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
          // Start the chunk at the beginning of the next line
          chunk = chunk.slice(pos + 1);
          pos = 0;
        }
        this._discardNextLineFeed = false;
      }

      const curCharCode = chunk.charCodeAt(pos);
      if (curCharCode === cr || curCharCode === lf) {
        this._lineBuf += chunk.slice(0, pos);
        this.__processEventStreamLine();

        // Start the chunk at the beginning of the next line
        chunk = chunk.slice(pos + 1);
        pos = 0;

        // Treat CRLF properly
        if (curCharCode === cr) {
          this._discardNextLineFeed = true;
        }
      }
    }

    // If there is any data remaining in the chunk, append it to the line buffer.
    if (chunk) {
      this._lineBuf += chunk;
    }
  }

  __processEventStreamLine(): void {
    let curPos = 0;
    const line = this._lineBuf;

    // Dispatch the buffered event if this is an empty line
    if (line === '') {
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
        data: this._dataBuf.slice(0, -1), // remove the trailing line feed
        origin: this.url,
        lastEventId: this._lastEventId,
      });

      // Reset the data and event type buffers
      this._dataBuf = "";
      this._eventTypeBuf = "";
    }

    const colonPos = line.indexOf(':');

    let field: string;
    let value: string;

    if (colonPos === 0) {
      // this is a comment line and should be ignored
      return;
    } else if (colonPos > 0) {
      if (line[colonPos + 1] == ' ') {
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

  __didCreateRequest(requestId: number): void {
    this._requestId = requestId;
  }

  __didReceiveResponse(
    requestId: number,
    status: number,
    responseHeaders: ?Object,
    responseURL: ?string,
  ): void {
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
        this.dispatchEvent({type: 'error', message: "HTTP error" + status});
        return this.close();
      }

      if (responseHeaders && responseHeaders["Content-Type"] !== "text/event-stream") {
        this.dispatchEvent({type: 'error', message: "unsupported MIME type in response"});
        return this.close();  
      }

      this.readyState = this.OPEN;
      this.dispatchEvent({type: 'open'});
    }
  }

  __didReceiveData(requestId: number, response: string): void {
    if (requestId !== this._requestId) {
      return;
    }

    console.log("__didReceiveData DOES NOT NEED TO BE HANDLED!!!!");
  }

  __didReceiveIncrementalData(
    requestId: number,
    responseText: string,
    progress: number,
    total: number,
  ) {
    if (requestId !== this._requestId) {
      return;
    }

    this.__processEventStreamChunk(responseText);
  }

  __didReceiveDataProgress(
    requestId: number,
    loaded: number,
    total: number,
  ): void {
    if (requestId !== this._requestId) {
      return;
    }

    console.log("__didReceiveDataProgress DOES NOT NEED TO BE HANDLED!!!!");
  }

  __didCompleteResponse(
    requestId: number,
    error: string,
    timeOutError: boolean,
  ): void {
    if (requestId === this._requestId) {
      console.log("__didCompleteResponse DOES NOT NEED TO BE HANDLED!!!!");
    }
  }

}

module.exports = EventSource;
