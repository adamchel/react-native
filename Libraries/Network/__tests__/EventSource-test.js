/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @emails oncall+react_native
 */

'use strict';
jest.unmock('../../Utilities/Platform');
const Platform = require('../../Utilities/Platform');
let requestId = 1;

function setRequestId(id) {
  if (Platform.OS === 'ios') {
    return;
  }
  requestId = id;
}

let capturedOptions;
jest
  .dontMock('event-target-shim')
  .setMock('../../BatchedBridge/NativeModules', {
    Networking: {
      addListener: function() {},
      removeListeners: function() {},
      sendRequest(options, callback) {
        capturedOptions = options;
        if (typeof callback === 'function') {
          // android does not pass a callback
          callback(requestId);
        }
      },
      abortRequest: function() {},
    },
  });

const EventSource = require('../EventSource');

describe('EventSource', function() {
    let eventSource;
    let handleOpen;
    let handleMessage;
    let handleError;

    const testUrl = "https://example.com/sse";

    const setupListeners = () => {
        eventSource.onopen = jest.fn();
        eventSource.onmessage = jest.fn();
        eventSource.onerror = jest.fn();

        handleOpen = jest.fn();
        handleMessage = jest.fn();
        handleError = jest.fn();

        eventSource.addEventListener('open', handleOpen);
        eventSource.addEventListener('message', handleMessage);
        eventSource.addEventListener('error', handleError);
    };

    afterEach(() => {
      if (eventSource) {
        eventSource.close(); // will not error if called twice

      }
      eventSource = null;
      handleOpen = null;
      handleMessage = null;
      handleError = null;
    });

    it('should transition readyState correctly for successful requests', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      expect(eventSource.readyState).toBe(EventSource.CONNECTING);

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );
      expect(eventSource.readyState).toBe(EventSource.OPEN);

      eventSource.close();
      expect(eventSource.readyState).toBe(EventSource.CLOSED);
    });

    
    it('should call onerror function when server responds with an HTTP error', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();
      
      expect(eventSource.readyState).toBe(EventSource.CONNECTING);
      
      eventSource.__didReceiveResponse(
        requestId, 404, {'content-type': 'text/plain'}, testUrl
      );

      expect(eventSource.onerror.mock.calls.length).toBe(1);
      expect(handleError.mock.calls.length).toBe(1);
      expect(eventSource.readyState).toBe(EventSource.CLOSED);
    });
      
    it('should call onerror on non event-stream responses', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      expect(eventSource.readyState).toBe(EventSource.CONNECTING);

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/plain'}, testUrl
      );

      expect(eventSource.onerror.mock.calls.length).toBe(1);
      expect(handleError.mock.calls.length).toBe(1);
      expect(eventSource.readyState).toBe(EventSource.CLOSED);
    });

    it('should call onerror function when request times out', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      expect(eventSource.readyState).toBe(EventSource.CONNECTING);

      eventSource.__didCompleteResponse(requestId, 'request timed out', true);

      expect(eventSource.onerror.mock.calls.length).toBe(1);
      expect(handleError.mock.calls.length).toBe(1);
      expect(eventSource.readyState).toBe(EventSource.CLOSED);
    });

    it('should call onerror if connection cannot be established', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didCompleteResponse(requestId, 'no internet', false);

      expect(eventSource.onerror.mock.calls.length).toBe(1);
      expect(handleError.mock.calls.length).toBe(1);
      expect(eventSource.readyState).toBe(EventSource.CLOSED);
    });

    it('should call onopen function when stream is opened', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );
      expect(eventSource.onopen.mock.calls.length).toBe(1);
      expect(handleOpen.mock.calls.length).toBe(1);
    });

    it('should follow HTTP redirects', function() {
      // TODO
    });

    it('should call onmessage when receiving an unnamed event', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId, 'data: this is an event\n\n', 
        0, 0 // these parameters are not used by the EventSource
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);
      
      const event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe('this is an event');
    });

    it('should handle events with multiple lines of data', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId, 
        'data: this is an event\n' +
        'data:with multiple lines\n' + // should not strip the 'w'
        'data: but it should come in as one event\n' +
        '\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);
      
      const event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe(
        'this is an event\nwith multiple lines\nbut it should come in as one event'
      );
    });

    it('should call appropriate handler when receiving a named event', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      const handleCustomEvent = jest.fn();
      eventSource.addEventListener('custom', handleCustomEvent);

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'event: custom\n' +
        'data: this is a custom event\n' +
        '\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(0);
      expect(handleMessage.mock.calls.length).toBe(0);

      expect(handleCustomEvent.mock.calls.length).toBe(1);
      
      const event = handleCustomEvent.mock.calls[0][0];
      expect(event.data).toBe('this is a custom event');
    });

    it('should receive multiple events', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      const handleCustomEvent = jest.fn();
      eventSource.addEventListener('custom', handleCustomEvent);

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'event: custom\n' +
        'data: this is a custom event\n' +
        '\n' +
        '\n' +
        'data: this is a normal event\n' +
        'data: with multiple lines\n' +
        '\n' +
        'data: this is a normal single-line event\n\n',
        0, 0
      );
      expect(handleCustomEvent.mock.calls.length).toBe(1);
      
      expect(eventSource.onmessage.mock.calls.length).toBe(2);
      expect(handleMessage.mock.calls.length).toBe(2);

    });

    it('should handle messages sent in separate chunks', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'data: this is ',
        0, 0
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'a normal event\n',
        0, 0
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'data: sent as separate ',
        0, 0
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'chunks\n\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);

      const event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe(
        'this is a normal event\nsent as separate chunks'
      );
    })

    it('should forward server-sent errors', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      const handleCustomEvent = jest.fn();
      eventSource.addEventListener('custom', handleCustomEvent);

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId,
        'event: error\n' +
        'data: the server sent this error\n\n',
        0, 0
      );
      
      expect(eventSource.onerror.mock.calls.length).toBe(1);
      expect(handleError.mock.calls.length).toBe(1);

      const event = eventSource.onerror.mock.calls[0][0];

      expect(event.data).toBe('the server sent this error');
    });

    it('should ignore comment lines', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId, 
        'data: this is an event\n' +
        ': don\'t mind me\n' + // this line should be ignored
        'data: on two lines\n' +
        '\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);
      
      const event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe(
        'this is an event\non two lines'
      );
    });

    it('should properly set lastEventId based on server message', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId, 
        'data: this is an event\n' +
        'id: with an id\n' +
        '\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);
      
      const event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe('this is an event');
      expect(eventSource._lastEventId).toBe('with an id');
    });

    it('should properly set reconnect interval based on server message', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      eventSource.__didReceiveIncrementalData(
        requestId, 
        'data: this is an event\n' +
        'retry: 5000\n' +
        '\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);
      
      let event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe('this is an event');
      expect(eventSource._reconnectIntervalMs).toBe(5000);
      

      // NaN should not change interval
      eventSource.__didReceiveIncrementalData(
        requestId, 
        'data: this is another event\n' +
        'retry: five\n' +
        '\n',
        0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(2);
      expect(handleMessage.mock.calls.length).toBe(2);
      
      event = eventSource.onmessage.mock.calls[1][0];

      expect(event.data).toBe('this is another event');
      expect(eventSource._reconnectIntervalMs).toBe(5000);
    });

    it('should handle messages with non-ASCII characters', function() {
      eventSource = new EventSource(testUrl);
      setupListeners();

      eventSource.__didReceiveResponse(
        requestId, 200, {'content-type': 'text/event-stream'}, testUrl
      );

      // flow doesn't like emojis: https://github.com/facebook/flow/issues/4219
      // so we have to add it programatically
      const emoji = String.fromCodePoint(128526);

      eventSource.__didReceiveIncrementalData(
        requestId, `data: ${emoji}\n\n`, 0, 0
      );
      
      expect(eventSource.onmessage.mock.calls.length).toBe(1);
      expect(handleMessage.mock.calls.length).toBe(1);
      
      const event = eventSource.onmessage.mock.calls[0][0];

      expect(event.data).toBe(emoji);
    });

    it('should properly pass along withCredentials option', function() {
      eventSource = new EventSource(testUrl, { withCredentials: true });
      expect(capturedOptions.withCredentials).toBeTruthy();

      eventSource = new EventSource(testUrl);
      expect(capturedOptions.withCredentials).toBeFalsy();
    });

    it('should properly pass along extra headers', function() {
      eventSource = new EventSource(testUrl, { headers: {'Custom-Header': 'some value'} });
    
      // make sure the default headers are passed in
      expect(capturedOptions.headers["Accept"]).toBe('text/event-stream');
      expect(capturedOptions.headers["Cache-Control"]).toBe('no-store');
      
      // make sure the custom header was passed in;
      expect(capturedOptions.headers["Custom-Header"]).toBe('some value');
    });

    it('should properly pass along configured lastEventId', function() {
      eventSource = new EventSource(testUrl, { headers: {'Last-Event-ID': 'my id'} });
    
      // make sure the default headers are passed in
      expect(capturedOptions.headers["Accept"]).toBe('text/event-stream');
      expect(capturedOptions.headers["Cache-Control"]).toBe('no-store');
      
      // make sure the event id was not passed in as a header
      expect(capturedOptions.headers["Last-Event-ID"]).toBeUndefined();

      // make sure the event id was set on the event source
      expect(eventSource._lastEventId).toBe('my id');
    });
});
